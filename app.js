/* ==========================================================================
   AIRBEAM QR - OPTICAL AIR-GAPPED DATA TRANSMISSION ENGINE
   ========================================================================== */

(function () {
    'use strict';

    // Global App State
    const state = {
        activeTab: 'send',
        file: null,
        fileBytes: null,
        transferId: '',
        chunks: [],
        totalChunks: 0,
        fps: 20,
        chunkSize: 350,
        
        // Sender Stream Loop
        senderTimer: null,
        currentFrameIdx: 0,
        loopCount: 0,
        isBeaming: false,
        isPaused: false,

        // Single persistent QRCode instance to prevent DOM destruction flickering
        qrInstance: null,
        qrStyle: 'fluid', // 'fluid' | 'cyber' | 'rounded' | 'classic'

        // Receiver Scanner State
        videoStream: null,
        scanAnimFrame: null,
        rxTransferId: '',
        rxFileMeta: null,
        rxReceivedChunks: new Map(), // chunkIndex => payload
        rxTotalChunks: 0,
        rxStartTime: 0,
        rxFrameCount: 0,
        rxLastFpsCalc: Date.now(),
        rxCurrentFps: 0,
        assembledBlob: null
    };

    // DOM Elements
    const dom = {
        // Tabs
        tabBtns: document.querySelectorAll('.tab-btn'),
        tabContents: document.querySelectorAll('.tab-content'),

        // Sender Elements
        dropZone: document.getElementById('drop-zone'),
        fileInput: document.getElementById('file-input'),
        fileDetails: document.getElementById('file-details'),
        fileName: document.getElementById('file-name'),
        fileSize: document.getElementById('file-size'),
        fileChunksCount: document.getElementById('file-chunks-count'),
        fileTypeIcon: document.getElementById('file-type-icon'),
        btnRemoveFile: document.getElementById('btn-remove-file'),
        
        fpsSlider: document.getElementById('fps-slider'),
        fpsValue: document.getElementById('fps-value'),
        chunkSizeSlider: document.getElementById('chunk-size-slider'),
        chunkSizeValue: document.getElementById('chunk-size-value'),
        
        btnStartBeam: document.getElementById('btn-start-beam'),
        btnPauseBeam: document.getElementById('btn-pause-beam'),
        btnStopBeam: document.getElementById('btn-stop-beam'),
        beamStatusBadge: document.getElementById('beam-status-badge'),
        
        qrCanvasWrapper: document.getElementById('qr-canvas-wrapper'),
        qrPlaceholder: document.getElementById('qr-placeholder'),
        
        statCurrentFrame: document.getElementById('stat-current-frame'),
        statLoopCount: document.getElementById('stat-loop-count'),
        statEstTime: document.getElementById('stat-est-time'),

        // Receiver Elements
        cameraSelect: document.getElementById('camera-select'),
        scannerVideo: document.getElementById('scanner-video'),
        scannerCanvas: document.getElementById('scanner-canvas'),
        cameraPlaceholder: document.getElementById('camera-placeholder'),
        btnStartCamera: document.getElementById('btn-start-camera'),
        btnStopCamera: document.getElementById('btn-stop-camera'),
        receiveStatusBadge: document.getElementById('receive-status-badge'),
        
        rxPercent: document.getElementById('rx-percent'),
        rxCount: document.getElementById('rx-count'),
        rxBar: document.getElementById('rx-bar'),
        rxFileName: document.getElementById('rx-file-name'),
        rxFileSize: document.getElementById('rx-file-size'),
        rxFpsStat: document.getElementById('rx-fps-stat'),
        chunkGrid: document.getElementById('chunk-grid'),
        downloadBox: document.getElementById('download-box'),
        downloadFileInfo: document.getElementById('download-file-info'),
        btnDownloadFile: document.getElementById('btn-download-file'),

        // Simulator
        btnRunSim: document.getElementById('btn-run-sim'),
        simSenderMount: document.getElementById('sim-sender-mount'),
        simReceiverMount: document.getElementById('sim-receiver-mount')
    };

    // Initialize App
    function init() {
        setupTabNavigation();
        setupFileUpload();
        setupSettingsControls();
        setupSenderControls();
        setupReceiverControls();
        setupSimulator();
    }

    /* ==========================================================================
       1. TAB NAVIGATION
       ========================================================================== */
    function setupTabNavigation() {
        dom.tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetTab = btn.getAttribute('data-tab');
                state.activeTab = targetTab;
                
                dom.tabBtns.forEach(b => b.classList.remove('active'));
                dom.tabContents.forEach(c => c.classList.remove('active'));
                
                btn.classList.add('active');
                document.getElementById(`tab-${targetTab}`).classList.add('active');

                // Camera lifecycle auto start/stop based on tab
                if (targetTab === 'receive' && !state.videoStream) {
                    startCamera();
                } else if (targetTab !== 'receive' && targetTab !== 'simulator' && state.videoStream) {
                    stopCamera();
                }
            });
        });
    }

    /* ==========================================================================
       2. FILE PROCESSING & CHUNKING
       ========================================================================== */
    function setupFileUpload() {
        ['dragenter', 'dragover'].forEach(eventName => {
            dom.dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dom.dropZone.classList.add('dragover');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dom.dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                dom.dropZone.classList.remove('dragover');
            });
        });

        dom.dropZone.addEventListener('drop', (e) => {
            const files = e.dataTransfer.files;
            if (files.length > 0) handleSelectedFile(files[0]);
        });

        dom.fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) handleSelectedFile(e.target.files[0]);
        });

        dom.btnRemoveFile.addEventListener('click', resetSelectedFile);
    }

    async function handleSelectedFile(file) {
        state.file = file;
        state.transferId = generateShortHash();
        
        // Read file as ArrayBuffer
        const buffer = await file.arrayBuffer();
        state.fileBytes = new Uint8Array(buffer);

        // Check if compression helps
        let finalBytes = state.fileBytes;
        let isCompressed = false;
        try {
            if ('CompressionStream' in window) {
                const compressedBytes = await compressBytes(state.fileBytes);
                if (compressedBytes.length < state.fileBytes.length) {
                    finalBytes = compressedBytes;
                    isCompressed = true;
                }
            }
        } catch (err) {
            console.warn('Compression skipped:', err);
        }

        // Build Chunks
        state.chunks = prepareTransmissionChunks({
            transferId: state.transferId,
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type || 'application/octet-stream',
            bytes: finalBytes,
            isCompressed: isCompressed,
            chunkSize: state.chunkSize
        });

        state.totalChunks = state.chunks.length;

        // UI Updates
        dom.fileName.textContent = file.name;
        dom.fileSize.textContent = formatBytes(file.size) + (isCompressed ? ' (Compressed)' : '');
        dom.fileChunksCount.textContent = `${state.totalChunks} Chunks`;
        dom.fileTypeIcon.className = getFileIconClass(file.name);

        dom.dropZone.classList.add('hidden');
        dom.fileDetails.classList.remove('hidden');
        dom.btnStartBeam.disabled = false;

        updateEstimatedTime();
    }

    function resetSelectedFile() {
        stopBeaming();
        state.file = null;
        state.fileBytes = null;
        state.chunks = [];
        state.totalChunks = 0;

        dom.fileInput.value = '';
        dom.dropZone.classList.remove('hidden');
        dom.fileDetails.classList.add('hidden');
        dom.btnStartBeam.disabled = true;
        
        state.qrInstance = null;
        dom.qrCanvasWrapper.innerHTML = '';
        dom.qrPlaceholder.classList.remove('hidden');
        dom.statCurrentFrame.textContent = '0 / 0';
        dom.statLoopCount.textContent = '0';
        dom.statEstTime.textContent = '-- s';
    }

    function prepareTransmissionChunks({ transferId, fileName, fileSize, mimeType, bytes, isCompressed, chunkSize }) {
        const chunkList = [];
        const dataChunksCount = Math.ceil(bytes.length / chunkSize);
        
        // Chunk 0: Metadata Payload
        const metaPayload = JSON.stringify({
            n: fileName,
            s: fileSize,
            t: mimeType,
            c: dataChunksCount,
            gz: isCompressed
        });

        // Header format: AQRT:1:<txId>:<index>:<totalDataChunks>:<payload>
        chunkList.push(`AQRT:1:${transferId}:0:${dataChunksCount}:${metaPayload}`);

        // Chunks 1 to N: Binary Payload (Base64 encoded)
        for (let i = 0; i < dataChunksCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, bytes.length);
            const slice = bytes.subarray(start, end);
            const base64Data = uint8ToBase64(slice);
            
            chunkList.push(`AQRT:1:${transferId}:${i + 1}:${dataChunksCount}:${base64Data}`);
        }

        return chunkList;
    }

    /* ==========================================================================
       3. TRANSMITTER (BEAMING PLAYER)
       ========================================================================== */
    function setupSettingsControls() {
        dom.fpsSlider.addEventListener('input', (e) => {
            state.fps = parseInt(e.target.value, 10);
            dom.fpsValue.textContent = `${state.fps} FPS`;
            updateEstimatedTime();

            if (state.isBeaming && !state.isPaused) {
                restartSenderTimer();
            }
        });

        dom.chunkSizeSlider.addEventListener('input', (e) => {
            state.chunkSize = parseInt(e.target.value, 10);
            dom.chunkSizeValue.textContent = `${state.chunkSize} Bytes`;
            
            if (state.file) {
                handleSelectedFile(state.file);
            }
        });

        // Preset Buttons
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                const preset = btn.getAttribute('data-preset');
                if (preset === 'reliable') state.chunkSize = 200;
                else if (preset === 'optimal') state.chunkSize = 350;
                else if (preset === 'speed') state.chunkSize = 500;
                
                dom.chunkSizeSlider.value = state.chunkSize;
                dom.chunkSizeValue.textContent = `${state.chunkSize} Bytes`;
                
                if (state.file) handleSelectedFile(state.file);
            });
        });

        // QR Style Switcher Chips
        document.querySelectorAll('.style-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.style-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                state.qrStyle = chip.getAttribute('data-style');
                renderCurrentQRFrame();
            });
        });
    }

    function setupSenderControls() {
        dom.btnStartBeam.addEventListener('click', startBeaming);
        dom.btnPauseBeam.addEventListener('click', togglePauseBeaming);
        dom.btnStopBeam.addEventListener('click', stopBeaming);
    }

    function startBeaming() {
        if (!state.chunks.length) return;

        state.isBeaming = true;
        state.isPaused = false;
        state.currentFrameIdx = 0;
        state.loopCount = 0;

        dom.qrPlaceholder.classList.add('hidden');
        dom.beamStatusBadge.classList.remove('hidden');
        
        dom.btnStartBeam.disabled = true;
        dom.btnPauseBeam.disabled = false;
        dom.btnStopBeam.disabled = false;

        state.preRenderedCanvases = [];
        preRenderAllQRCanvases();

        renderCurrentQRFrame();
        restartSenderTimer();
    }

    function restartSenderTimer() {
        if (state.senderTimer) clearInterval(state.senderTimer);
        const intervalMs = Math.round(1000 / state.fps);
        
        state.senderTimer = setInterval(() => {
            if (state.isPaused) return;

            state.currentFrameIdx++;
            if (state.currentFrameIdx >= state.chunks.length) {
                state.currentFrameIdx = 0;
                state.loopCount++;
            }

            renderCurrentQRFrame();
            updateSenderStats();
        }, intervalMs);
    }

    function preRenderAllQRCanvases() {
        state.preRenderedCanvases = [];
        const size = 280;

        for (let i = 0; i < state.chunks.length; i++) {
            const payloadStr = state.chunks[i];
            const offCanvas = document.createElement('canvas');
            offCanvas.width = size;
            offCanvas.height = size;

            drawQRFrameToCanvas(offCanvas, payloadStr);
            state.preRenderedCanvases.push(offCanvas);
        }
    }

    function drawQRFrameToCanvas(canvas, payloadStr) {
        if (typeof qrcode !== 'function') return;

        const qr = qrcode(0, 'L');
        qr.addData(payloadStr);
        qr.make();

        const moduleCount = qr.getModuleCount();
        const marginModules = 4; // Mandatory ISO Quiet Zone (white margin)
        const totalModules = moduleCount + (marginModules * 2);
        
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        const cellSize = size / totalModules;

        // Crisp White Quiet Zone Background for 100% camera contrast
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, size, size);

        const theme = state.qrStyle || 'fluid';

        if (theme === 'fluid') {
            // Organic Circuit / Fluid Art QR Style matching user's reference image!
            drawFluidCircuitQR(ctx, qr, moduleCount, marginModules, cellSize, size);
            return;
        }

        // Draw QR modules inside padded quiet zone
        for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
                if (qr.isDark(r, c)) {
                    const x = Math.floor((c + marginModules) * cellSize);
                    const y = Math.floor((r + marginModules) * cellSize);
                    const w = Math.ceil((c + marginModules + 1) * cellSize) - x;
                    const h = Math.ceil((r + marginModules + 1) * cellSize) - y;

                    const isTopLeft = (r < 7 && c < 7);
                    const isTopRight = (r < 7 && c >= moduleCount - 7);
                    const isBottomLeft = (r >= moduleCount - 7 && c < 7);
                    const isFinderEye = isTopLeft || isTopRight || isBottomLeft;

                    if (theme === 'cyber' && isFinderEye) {
                        ctx.fillStyle = '#080d1a';
                        ctx.fillRect(x, y, w, h);
                    } else if (theme === 'rounded' && !isFinderEye) {
                        ctx.fillStyle = '#0b0f19';
                        ctx.beginPath();
                        ctx.arc(x + w / 2, y + h / 2, Math.max(1, w / 2 - 0.2), 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        ctx.fillStyle = '#060a14';
                        ctx.fillRect(x, y, w, h);
                    }
                }
            }
        }

        // Draw Stylish Central Brand Logo Badge Overlay
        drawCentralLogoBadge(ctx, size);
    }

    function drawFluidCircuitQR(ctx, qr, moduleCount, marginModules, cellSize, size) {
        const darkColor = '#111827';

        function isDark(r, c) {
            if (r < 0 || r >= moduleCount || c < 0 || c >= moduleCount) return false;
            return qr.isDark(r, c);
        }

        function isFinderPattern(r, c) {
            const isTL = (r < 7 && c < 7);
            const isTR = (r < 7 && c >= moduleCount - 7);
            const isBL = (r >= moduleCount - 7 && c < 7);
            return isTL || isTR || isBL;
        }

        // 1. Draw Organic Connected Circuit / Liquid Modules
        ctx.fillStyle = darkColor;

        for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
                if (isFinderPattern(r, c)) continue;
                
                if (qr.isDark(r, c)) {
                    const x = (c + marginModules) * cellSize;
                    const y = (r + marginModules) * cellSize;
                    const radius = cellSize * 0.42;

                    const right = isDark(r, c + 1) && !isFinderPattern(r, c + 1);
                    const bottom = isDark(r + 1, c) && !isFinderPattern(r + 1, c);

                    // Central pill/dot module
                    ctx.beginPath();
                    if (ctx.roundRect) {
                        ctx.roundRect(x + 0.5, y + 0.5, cellSize - 1, cellSize - 1, radius);
                    } else {
                        ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.42, 0, Math.PI * 2);
                    }
                    ctx.fill();

                    // Fluid connections to neighbors
                    if (right) {
                        ctx.fillRect(x + cellSize / 2, y + 1, cellSize, cellSize - 2);
                    }
                    if (bottom) {
                        ctx.fillRect(x + 1, y + cellSize / 2, cellSize - 2, cellSize);
                    }
                }
            }
        }

        // 2. Draw Rounded Finder Pattern Eyes (3 Corners) matching user's image!
        const eyePositions = [
            { r: 0, c: 0 },
            { r: 0, c: moduleCount - 7 },
            { r: moduleCount - 7, c: 0 }
        ];

        for (const pos of eyePositions) {
            const eyeX = (pos.c + marginModules) * cellSize;
            const eyeY = (pos.r + marginModules) * cellSize;
            const eyeSize = 7 * cellSize;

            const ringRadius = eyeSize * 0.28;
            const ringWidth = cellSize * 1.05;

            // Outer Eye Ring
            ctx.fillStyle = darkColor;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(eyeX, eyeY, eyeSize, eyeSize, ringRadius);
            } else {
                ctx.rect(eyeX, eyeY, eyeSize, eyeSize);
            }
            ctx.fill();

            // Inner Cutout
            ctx.fillStyle = '#FFFFFF';
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(eyeX + ringWidth, eyeY + ringWidth, eyeSize - (ringWidth * 2), eyeSize - (ringWidth * 2), ringRadius * 0.6);
            } else {
                ctx.rect(eyeX + ringWidth, eyeY + ringWidth, eyeSize - (ringWidth * 2), eyeSize - (ringWidth * 2));
            }
            ctx.fill();

            // Center Eye Dot
            ctx.fillStyle = darkColor;
            ctx.beginPath();
            const dotSize = 3 * cellSize;
            const dotOffset = 2 * cellSize;
            if (ctx.roundRect) {
                ctx.roundRect(eyeX + dotOffset, eyeY + dotOffset, dotSize, dotSize, dotSize * 0.32);
            } else {
                ctx.arc(eyeX + eyeSize / 2, eyeY + eyeSize / 2, dotSize / 2, 0, Math.PI * 2);
            }
            ctx.fill();
        }

        // 3. Draw Central Target Ring Badge matching user reference image!
        const badgeR = cellSize * 2.8;
        const centerX = size / 2;
        const centerY = size / 2;

        // Clear center background
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        ctx.arc(centerX, centerY, badgeR + 3, 0, Math.PI * 2);
        ctx.fill();

        // Outer Ring
        ctx.strokeStyle = darkColor;
        ctx.lineWidth = cellSize * 1.1;
        ctx.beginPath();
        ctx.arc(centerX, centerY, badgeR, 0, Math.PI * 2);
        ctx.stroke();

        // Center Inner Dot
        ctx.fillStyle = darkColor;
        ctx.beginPath();
        ctx.arc(centerX, centerY, badgeR * 0.45, 0, Math.PI * 2);
        ctx.fill();
    }

    function drawCentralLogoBadge(ctx, size) {
        const logoW = Math.floor(size * 0.22); // 22% of QR width
        const logoH = Math.floor(size * 0.16);
        const logoX = (size - logoW) / 2;
        const logoY = (size - logoH) / 2;

        // Outer White Margin Box (clears QR modules under logo)
        ctx.fillStyle = '#FFFFFF';
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(logoX - 3, logoY - 3, logoW + 6, logoH + 6, 8);
        } else {
            ctx.rect(logoX - 3, logoY - 3, logoW + 6, logoH + 6);
        }
        ctx.fill();

        // Inner Navy Glass Badge
        ctx.fillStyle = '#090e1a';
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(logoX, logoY, logoW, logoH, 6);
        } else {
            ctx.rect(logoX, logoY, logoW, logoH);
        }
        ctx.fill();

        // Cyan Border Line
        ctx.strokeStyle = '#00f2fe';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Brand Icon / Text inside Logo
        ctx.fillStyle = '#00f2fe';
        ctx.font = '700 13px "Outfit", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚡ AIR', size / 2, size / 2);
    }

    function renderCurrentQRFrame() {
        const payloadStr = state.chunks[state.currentFrameIdx];
        if (!payloadStr) return;

        let canvas = dom.qrCanvasWrapper.querySelector('canvas');
        if (!canvas) {
            dom.qrCanvasWrapper.innerHTML = '';
            canvas = document.createElement('canvas');
            canvas.width = 280;
            canvas.height = 280;
            dom.qrCanvasWrapper.appendChild(canvas);
        }

        // Zero CPU Lag Fast Render: Copy from Pre-rendered Canvases
        if (state.preRenderedCanvases && state.preRenderedCanvases[state.currentFrameIdx]) {
            const ctx = canvas.getContext('2d');
            ctx.drawImage(state.preRenderedCanvases[state.currentFrameIdx], 0, 0);
        } else {
            drawQRFrameToCanvas(canvas, payloadStr);
        }
    }

    function togglePauseBeaming() {
        state.isPaused = !state.isPaused;
        if (state.isPaused) {
            dom.btnPauseBeam.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
            dom.beamStatusBadge.classList.add('hidden');
        } else {
            dom.btnPauseBeam.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
            dom.beamStatusBadge.classList.remove('hidden');
        }
    }

    function stopBeaming() {
        state.isBeaming = false;
        state.isPaused = false;
        if (state.senderTimer) clearInterval(state.senderTimer);
        state.senderTimer = null;

        state.qrInstance = null;
        dom.qrCanvasWrapper.innerHTML = '';
        dom.qrPlaceholder.classList.remove('hidden');
        dom.beamStatusBadge.classList.add('hidden');
        dom.btnStartBeam.disabled = !state.file;
        dom.btnPauseBeam.disabled = true;
        dom.btnStopBeam.disabled = true;
        dom.btnPauseBeam.innerHTML = '<i class="fa-solid fa-pause"></i> Pause';
    }

    function updateSenderStats() {
        dom.statCurrentFrame.textContent = `${state.currentFrameIdx + 1} / ${state.chunks.length}`;
        dom.statLoopCount.textContent = `${state.loopCount}`;
    }

    function updateEstimatedTime() {
        if (!state.chunks.length) return;
        const seconds = Math.ceil(state.chunks.length / state.fps);
        dom.statEstTime.textContent = `${seconds}s / loop`;
    }

    /* ==========================================================================
       4. RECEIVER (CAMERA SCANNER & RECONSTRUCTION)
       ========================================================================== */
    function setupReceiverControls() {
        dom.btnStartCamera.addEventListener('click', startCamera);
        dom.btnStopCamera.addEventListener('click', stopCamera);
        dom.btnDownloadFile.addEventListener('click', triggerFileDownload);
        
        dom.cameraSelect.addEventListener('change', () => {
            if (state.videoStream) {
                startCamera();
            }
        });
    }

    async function enumerateCameras() {
        try {
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices.filter(d => d.kind === 'videoinput');
            
            dom.cameraSelect.innerHTML = '<option value="">Default Camera</option>';
            videoDevices.forEach((device, index) => {
                const opt = document.createElement('option');
                opt.value = device.deviceId;
                opt.textContent = device.label || `Camera ${index + 1}`;
                dom.cameraSelect.appendChild(opt);
            });
        } catch (e) {
            console.warn('Unable to list cameras:', e);
        }
    }

    async function startCamera() {
        // Check for secure context or mediaDevices support
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const isHttpIp = window.location.protocol === 'http:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
            
            if (isHttpIp) {
                alert('⚠️ MOBILE CAMERA ERROR: Mobile browsers block camera access on unencrypted HTTP IP links (http://' + window.location.hostname + ').\n\nPlease use an HTTPS tunnel (e.g. npx localtunnel --port 8080) or host on Netlify for HTTPS camera access!');
            } else {
                alert('Camera API (getUserMedia) is not supported or permission was denied in this browser.');
            }
            return;
        }

        try {
            const selectedDeviceId = dom.cameraSelect.value;
            
            // Multiple fallback constraints for broad mobile device compatibility (iOS/Android)
            const constraintOptions = [
                {
                    video: {
                        deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined,
                        facingMode: selectedDeviceId ? undefined : { ideal: 'environment' },
                        width: { ideal: 1280 },
                        height: { ideal: 720 }
                    }
                },
                {
                    video: {
                        facingMode: 'environment'
                    }
                },
                {
                    video: true
                }
            ];

            let stream = null;
            let lastErr = null;

            for (const option of constraintOptions) {
                try {
                    stream = await navigator.mediaDevices.getUserMedia(option);
                    if (stream) break;
                } catch (e) {
                    lastErr = e;
                }
            }

            if (!stream) throw lastErr || new Error('Failed to acquire camera stream');

            state.videoStream = stream;
            dom.scannerVideo.srcObject = state.videoStream;

            // Crucial iOS Safari attributes for inline video playback
            dom.scannerVideo.setAttribute('playsinline', 'true');
            dom.scannerVideo.setAttribute('muted', 'true');
            dom.scannerVideo.muted = true;

            await dom.scannerVideo.play();

            dom.cameraPlaceholder.classList.add('hidden');
            dom.btnStopCamera.disabled = false;
            dom.receiveStatusBadge.textContent = 'Scanning for QR...';
            dom.receiveStatusBadge.className = 'badge';

            enumerateCameras();
            startScanningLoop();
        } catch (err) {
            console.error('Camera access failed:', err);
            alert('Unable to access camera: ' + (err.message || err.name) + '\n\nMake sure camera permission is granted in mobile browser settings.');
        }
    }

    function stopCamera() {
        if (state.scanAnimFrame) cancelAnimationFrame(state.scanAnimFrame);
        state.scanAnimFrame = null;

        if (state.videoStream) {
            state.videoStream.getTracks().forEach(track => track.stop());
            state.videoStream = null;
        }

        dom.scannerVideo.srcObject = null;
        dom.cameraPlaceholder.classList.remove('hidden');
        dom.btnStopCamera.disabled = true;
        dom.receiveStatusBadge.textContent = 'Camera Off';
    }

    let barcodeDetector = null;
    if ('BarcodeDetector' in window) {
        try {
            BarcodeDetector.getSupportedFormats().then(formats => {
                if (formats.includes('qr_code')) {
                    barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
                }
            }).catch(() => {});
        } catch (e) {}
    }

    function startScanningLoop() {
        const canvas = dom.scannerCanvas;
        // Set fixed optimal 480x480 resolution ONLY ONCE to avoid buffer reallocation
        canvas.width = 480;
        canvas.height = 480;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let isDetectingNative = false;

        function scanFrame() {
            if (!state.videoStream) return;

            if (dom.scannerVideo.readyState === dom.scannerVideo.HAVE_ENOUGH_DATA) {
                // Hardware accelerated native scanner (Android/Chrome/iOS)
                if (barcodeDetector && !isDetectingNative) {
                    isDetectingNative = true;
                    barcodeDetector.detect(dom.scannerVideo).then(barcodes => {
                        isDetectingNative = false;
                        recordScanFps();
                        if (barcodes && barcodes.length > 0) {
                            for (const barcode of barcodes) {
                                if (barcode.rawValue && barcode.rawValue.startsWith('AQRT:1:')) {
                                    handleScannedQRChunk(barcode.rawValue);
                                    break;
                                }
                            }
                        }
                    }).catch(() => {
                        isDetectingNative = false;
                    });
                } else if (!barcodeDetector) {
                    // Optimized 480x480 downsampled jsQR fallback
                    ctx.drawImage(dom.scannerVideo, 0, 0, canvas.width, canvas.height);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    
                    const code = jsQR(imageData.data, imageData.width, imageData.height, {
                        inversionAttempts: 'dontInvert'
                    });

                    recordScanFps();

                    if (code && code.data && code.data.startsWith('AQRT:1:')) {
                        handleScannedQRChunk(code.data);
                    }
                }
            }

            state.scanAnimFrame = requestAnimationFrame(scanFrame);
        }

        state.scanAnimFrame = requestAnimationFrame(scanFrame);
    }

    function recordScanFps() {
        state.rxFrameCount++;
        const now = Date.now();
        if (now - state.rxLastFpsCalc >= 1000) {
            state.rxCurrentFps = Math.round((state.rxFrameCount * 1000) / (now - state.rxLastFpsCalc));
            dom.rxFpsStat.textContent = `${state.rxCurrentFps} FPS`;
            state.rxFrameCount = 0;
            state.rxLastFpsCalc = now;
        }
    }

    /* ==========================================================================
       5. CHUNK ACCUMULATOR & FILE REASSEMBLY
       ========================================================================== */
    function handleScannedQRChunk(qrText) {
        // Format: AQRT:1:<txId>:<index>:<totalDataChunks>:<payload>
        const parts = qrText.split(':');
        if (parts.length < 6) return;

        const txId = parts[2];
        const chunkIdx = parseInt(parts[3], 10);
        const totalDataChunks = parseInt(parts[4], 10);
        const payload = parts.slice(5).join(':'); // handles payload with colons if any

        // If new transmission session detected
        if (txId !== state.rxTransferId) {
            state.rxTransferId = txId;
            state.rxFileMeta = null;
            state.rxReceivedChunks.clear();
            state.rxTotalChunks = totalDataChunks;
            state.assembledBlob = null;
            
            dom.downloadBox.classList.add('hidden');
            dom.receiveStatusBadge.textContent = 'Receiving Data...';
            dom.receiveStatusBadge.className = 'badge offline-badge';
            
            initChunkMatrixGrid(totalDataChunks);
        }

        // Store chunk
        if (!state.rxReceivedChunks.has(chunkIdx)) {
            state.rxReceivedChunks.set(chunkIdx, payload);

            // Handle metadata chunk (Index 0)
            if (chunkIdx === 0) {
                try {
                    state.rxFileMeta = JSON.parse(payload);
                    dom.rxFileName.textContent = state.rxFileMeta.n;
                    dom.rxFileSize.textContent = formatBytes(state.rxFileMeta.s);
                } catch (e) {
                    console.error('Invalid meta payload:', e);
                }
            }

            // Update Matrix Block UI
            markChunkAsReceivedInGrid(chunkIdx);
            
            // Update Progress Bar
            updateReceiverProgress();

            // Check if 100% complete
            checkReassemblyCompletion();
        }
    }

    function initChunkMatrixGrid(totalDataChunks) {
        dom.chunkGrid.innerHTML = '';
        
        // Block 0 is Meta Chunk
        const metaBlock = document.createElement('div');
        metaBlock.className = 'chunk-block';
        metaBlock.id = `chunk-blk-0`;
        metaBlock.title = 'Meta Chunk (Info)';
        dom.chunkGrid.appendChild(metaBlock);

        for (let i = 1; i <= totalDataChunks; i++) {
            const blk = document.createElement('div');
            blk.className = 'chunk-block';
            blk.id = `chunk-blk-${i}`;
            blk.title = `Data Chunk #${i}`;
            dom.chunkGrid.appendChild(blk);
        }
    }

    function markChunkAsReceivedInGrid(chunkIdx) {
        const blk = document.getElementById(`chunk-blk-${chunkIdx}`);
        if (blk) blk.classList.add('received');
    }

    function updateReceiverProgress() {
        const totalNeeded = state.rxTotalChunks + 1; // Meta + Data
        const currentCount = state.rxReceivedChunks.size;
        const percent = Math.min(100, Math.round((currentCount / totalNeeded) * 100));

        dom.rxPercent.textContent = `${percent}%`;
        dom.rxCount.textContent = `${currentCount} / ${totalNeeded} Chunks Collected`;
        dom.rxBar.style.width = `${percent}%`;
    }

    async function checkReassemblyCompletion() {
        const totalNeeded = state.rxTotalChunks + 1;
        if (state.rxReceivedChunks.size === totalNeeded && !state.assembledBlob) {
            
            dom.receiveStatusBadge.textContent = 'Reassembling File...';
            
            try {
                // Ensure meta exists
                if (!state.rxFileMeta) {
                    const metaStr = state.rxReceivedChunks.get(0);
                    state.rxFileMeta = JSON.parse(metaStr);
                }

                // Collect data chunks in exact order 1..N
                const byteArrays = [];
                let totalByteLength = 0;

                for (let i = 1; i <= state.rxTotalChunks; i++) {
                    const b64 = state.rxReceivedChunks.get(i);
                    const bytes = base64ToUint8(b64);
                    byteArrays.push(bytes);
                    totalByteLength += bytes.length;
                }

                // Combine into single Uint8Array
                const combinedBytes = new Uint8Array(totalByteLength);
                let offset = 0;
                for (const arr of byteArrays) {
                    combinedBytes.set(arr, offset);
                    offset += arr.length;
                }

                // Decompress if compressed
                let finalBytes = combinedBytes;
                if (state.rxFileMeta.gz && 'DecompressionStream' in window) {
                    finalBytes = await decompressBytes(combinedBytes);
                }

                // Create File Blob
                state.assembledBlob = new Blob([finalBytes], { type: state.rxFileMeta.t });

                // UI Success state
                dom.receiveStatusBadge.textContent = 'Completed 100%';
                dom.receiveStatusBadge.className = 'badge offline-badge';

                dom.downloadFileInfo.textContent = `${state.rxFileMeta.n} • ${formatBytes(state.rxFileMeta.s)}`;
                dom.downloadBox.classList.remove('hidden');

            } catch (err) {
                console.error('File reassembly failed:', err);
                alert('Error reassembling file: ' + err.message);
            }
        }
    }

    function triggerFileDownload() {
        if (!state.assembledBlob || !state.rxFileMeta) return;

        const url = URL.createObjectURL(state.assembledBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = state.rxFileMeta.n;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /* ==========================================================================
       6. DUAL SCREEN SIMULATOR MODE
       ========================================================================== */
    function setupSimulator() {
        dom.btnRunSim.addEventListener('click', runSingleScreenSimulation);
    }

    async function runSingleScreenSimulation() {
        dom.simSenderMount.innerHTML = `
            <div class="sim-box text-center">
                <div class="qr-box cyber-frame mx-auto mb-15" style="width: 240px; height: 240px; margin: 0 auto 15px auto;">
                    <canvas id="sim-sender-canvas" width="220" height="220"></canvas>
                </div>
                <div class="badge offline-badge mb-10"><span class="status-dot green pulse"></span> Sim Beaming Live</div>
                <p class="text-muted font-sm">Streaming <strong>AirBeam_Sample_Document.txt</strong> (12 Chunks)</p>
            </div>
        `;

        dom.simReceiverMount.innerHTML = `
            <div class="sim-box">
                <div class="progress-section mb-15">
                    <div class="progress-info">
                        <span class="progress-percent" id="sim-percent">0%</span>
                        <span class="progress-count" id="sim-count">0 / 12 Chunks</span>
                    </div>
                    <div class="progress-bar-bg">
                        <div class="progress-bar-fill" id="sim-bar" style="width: 0%;"></div>
                    </div>
                    <div class="rx-meta-row mt-15">
                        <div><i class="fa-solid fa-file"></i> File: <strong>AirBeam_Sample_Document.txt</strong></div>
                        <div><i class="fa-solid fa-weight-hanging"></i> Status: <strong id="sim-status" class="text-green">Optical Loopback Active</strong></div>
                    </div>
                </div>

                <div class="chunk-matrix-container">
                    <h4>Simulated Reassembly Grid</h4>
                    <div class="chunk-grid" id="sim-chunk-grid"></div>
                </div>

                <div id="sim-download-area" class="download-box mt-20 hidden">
                    <div class="success-banner">
                        <i class="fa-solid fa-circle-check text-green icon-lg"></i>
                        <div>
                            <h4>Simulation Complete!</h4>
                            <p>AirBeam_Sample_Document.txt reassembled losslessly.</p>
                        </div>
                    </div>
                    <button class="btn btn-success btn-large w-100 mt-15" id="btn-sim-dl">
                        <i class="fa-solid fa-download"></i> Download Simulated File
                    </button>
                </div>
            </div>
        `;

        // Generate Sample File Chunks
        const sampleText = 'AirBeam QR - 100% Offline Optical Air-Gapped Data Transmission System.\n'.repeat(40);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(sampleText);
        const txId = 'sim' + generateShortHash();
        
        const simChunks = prepareTransmissionChunks({
            transferId: txId,
            fileName: 'AirBeam_Sample_Document.txt',
            fileSize: bytes.length,
            mimeType: 'text/plain',
            bytes: bytes,
            isCompressed: false,
            chunkSize: 300
        });

        // Setup Sim Chunk Grid
        const gridEl = document.getElementById('sim-chunk-grid');
        gridEl.innerHTML = '';
        for (let i = 0; i < simChunks.length; i++) {
            const blk = document.createElement('div');
            blk.className = 'chunk-block';
            blk.id = `sim-blk-${i}`;
            blk.title = `Sim Chunk #${i}`;
            gridEl.appendChild(blk);
        }

        // Run Loop Simulation
        let idx = 0;
        const received = new Set();
        const canvas = document.getElementById('sim-sender-canvas');

        const simTimer = setInterval(() => {
            const payload = simChunks[idx];
            if (canvas) {
                drawQRFrameToCanvas(canvas, payload);
            }

            // Simulate Optical Capture
            if (!received.has(idx)) {
                received.add(idx);
                const blk = document.getElementById(`sim-blk-${idx}`);
                if (blk) blk.classList.add('received');

                const pct = Math.round((received.size / simChunks.length) * 100);
                document.getElementById('sim-percent').textContent = `${pct}%`;
                document.getElementById('sim-count').textContent = `${received.size} / ${simChunks.length} Chunks`;
                document.getElementById('sim-bar').style.width = `${pct}%`;
            }

            if (received.size === simChunks.length) {
                clearInterval(simTimer);
                document.getElementById('sim-status').textContent = 'Completed 100%';
                document.getElementById('sim-download-area').classList.remove('hidden');

                const blob = new Blob([sampleText], { type: 'text/plain' });
                document.getElementById('btn-sim-dl').addEventListener('click', () => {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'AirBeam_Sample_Document.txt';
                    a.click();
                    URL.revokeObjectURL(url);
                });
            }

            idx = (idx + 1) % simChunks.length;
        }, 120);
    }

    /* ==========================================================================
       7. UTILITY & HELPER FUNCTIONS
       ========================================================================== */
    async function compressBytes(uint8Array) {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(uint8Array);
        writer.close();
        const response = new Response(cs.readable);
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    async function decompressBytes(uint8Array) {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(uint8Array);
        writer.close();
        const response = new Response(ds.readable);
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    function uint8ToBase64(uint8) {
        let binary = '';
        const len = uint8.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(uint8[i]);
        }
        return btoa(binary);
    }

    function base64ToUint8(base64) {
        const binary = atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    function generateShortHash() {
        return Math.random().toString(36).substring(2, 8);
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function getFileIconClass(fileName) {
        const ext = fileName.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return 'fa-solid fa-file-image';
        if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return 'fa-solid fa-file-lines';
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'fa-solid fa-file-zipper';
        if (['js', 'html', 'css', 'py', 'json'].includes(ext)) return 'fa-solid fa-file-code';
        return 'fa-solid fa-file';
    }

    // Run Initialization on DOM Load
    document.addEventListener('DOMContentLoaded', init);

})();
