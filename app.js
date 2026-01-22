// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_LOCK_TIMEOUT   = 15000;
const AUTO_RESTART_MS    = 1200;

document.addEventListener('DOMContentLoaded', () => {
  const searchInput   = document.getElementById('searchInput');
  const searchBtn     = document.getElementById('searchBtn');
  const qrVideo       = document.getElementById('qrVideo');
  const cameraSelect  = document.getElementById('cameraSelect');
  const startButton   = document.getElementById('startCamera');
  const stopButton    = document.getElementById('stopCamera');

  const codeReader = new ZXing.BrowserQRCodeReader();

  // ========= State =========
  let currentDeviceId = "";
  let cameraStarted = false;
  let apiBusy = false;

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let activeStream = null;          // stream ที่ใช้อยู่จริง
  let permissionState = "unknown";  // "granted" | "denied" | "prompt" | "unknown"
  let starting = false;             // กันกดเปิดกล้องซ้อน

  // ========= UX =========
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };
  searchInput.addEventListener('input', () => { searchInput.value = searchInput.value.toUpperCase(); });
  searchBtn.addEventListener('click', () => runSearch(searchInput.value));
  searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });

  // ✅ มาตรฐาน: ขอ permission เฉพาะจาก user gesture (กดปุ่ม)
  startButton.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    try {
      await startFlow_();
    } finally {
      starting = false;
    }
  });

  stopButton.addEventListener('click', () => stopCamera());

  // สลับกล้อง: stop ก่อน แล้วค่อย start ใหม่ (ไม่ขอ permission ซ้ำถ้า granted แล้ว)
  cameraSelect.addEventListener('change', async () => {
    if (!cameraStarted) return;
    await restartWithDevice_(cameraSelect.value);
  });

  // ======== Permission / Device =========

  async function queryCameraPermission_() {
    // permissions API ไม่รองรับทุกเบราว์เซอร์ → fallback unknown
    try {
      if (!navigator.permissions?.query) return "unknown";
      const p = await navigator.permissions.query({ name: "camera" });
      permissionState = p.state || "unknown";
      // ติดตามการเปลี่ยน state
      try {
        p.onchange = () => { permissionState = p.state || "unknown"; };
      } catch (_) {}
      return permissionState;
    } catch (_) {
      return "unknown";
    }
  }

  async function listVideoDevices_() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";
    if (isMobile_()) {
      // หลัง permission แล้ว label มักมี back/rear
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
      return (back?.deviceId) || devices[0].deviceId;
    }
    return devices[0].deviceId;
  }

  async function refreshCameraSelect_() {
    const cams = await listVideoDevices_();

    cameraSelect.innerHTML = "";
    cams.forEach((d, idx) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId || "";
      opt.textContent = d.label || `Camera ${idx + 1}`;
      cameraSelect.appendChild(opt);
    });

    const def = pickDefaultDevice_(cams);
    if (!currentDeviceId) currentDeviceId = def;
    if (currentDeviceId) cameraSelect.value = currentDeviceId;
  }

  // ======== Camera start flow (Modern Standard) =========
  async function startFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return Swal.fire({ icon:'error', title:'ไม่รองรับกล้อง', text:'เบราว์เซอร์นี้ไม่รองรับ getUserMedia', confirmButtonText:'OK' });
    }

    // 1) ตรวจ permission state (ถ้ารองรับ)
    const p = await queryCameraPermission_();

    // 2) ถ้า denied → บอกวิธีเปิดสิทธิ์ (อย่าพยายามเรียก getUserMedia ซ้ำ จะเด้ง/ล้มเหลว)
    if (p === "denied") {
      return Swal.fire({
        icon: 'warning',
        title: 'ไม่ได้รับอนุญาตใช้กล้อง',
        html: `
          <div style="text-align:left;font-size:14px">
            กรุณาอนุญาตกล้องในการตั้งค่าเบราว์เซอร์/โทรศัพท์ แล้วลองใหม่<br><br>
            • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
            • Android: Site settings → Camera → Allow<br><br>
            จากนั้นกลับมากด “เปิดกล้อง” อีกครั้ง
          </div>
        `,
        confirmButtonText: 'OK',
        allowOutsideClick: false
      });
    }

    // 3) ถ้าเคยมี stream แล้วและยังใช้งานได้ → ไม่ขอ permission ใหม่ (กันเด้งซ้ำ)
    if (activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      try { await refreshCameraSelect_(); } catch (_) {}
      decodeLoop_(currentDeviceId || null);
      return;
    }

    // 4) ขอ stream “ครั้งเดียว” (permission prompt จะขึ้นเฉพาะครั้งนี้)
    //    ใช้ fallback แบบมาตรฐาน: deviceId(ถ้ามี) → facingMode → video:true
    await openCameraOnce_();

    // 5) หลังได้ permission แล้ว ค่อย refresh รายชื่อกล้อง (label/deviceId จะมาเต็ม)
    try { await refreshCameraSelect_(); } catch (_) {}

    cameraStarted = true;
    decodeLoop_(currentDeviceId || null);
  }

  async function openCameraOnce_() {
    // ปิดก่อนเผื่อค้าง
    await stopCamera();

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      qrVideo.srcObject = stream;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    // Try 1: exact deviceId (ถ้ามี)
    if (wantDeviceId) {
      try {
        await tryOpen({
          audio: false,
          video: {
            deviceId: { exact: wantDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 }
          }
        });
        currentDeviceId = wantDeviceId;
        return;
      } catch (_) {}
    }

    // Try 2: facingMode environment (มือถือ)
    try {
      await tryOpen({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        }
      });
      return;
    } catch (_) {}

    // Try 3: video:true (ให้ browser เลือกเอง)
    try {
      await tryOpen({ video: true, audio: false });
      return;
    } catch (err) {
      console.error("openCameraOnce_ failed:", err);
      throw err;
    }
  }

  async function restartWithDevice_(deviceId) {
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      await openCameraOnce_();          // เปิดใหม่ครั้งเดียว
      cameraStarted = true;
      decodeLoop_(currentDeviceId || null);
    } catch (err) {
      cameraStarted = false;
      Swal.fire({
        icon: 'error',
        title: 'สลับกล้องไม่สำเร็จ',
        text: 'ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง',
        confirmButtonText: 'OK'
      });
    }
  }

  async function stopCamera() {
    apiBusy = false;
    cameraStarted = false;

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;
  }

  function decodeLoop_(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!result) return;

      const now = Date.now();
      if (apiBusy) return;
      if (now - lastScanAt < SCAN_COOLDOWN_MS) return;

      const text = String(result.getText() || "").trim().toUpperCase();
      if (!text) return;

      if (text === lastText && (now - lastTextAt) < SAME_CODE_HOLD_MS) return;

      lastScanAt = now;
      lastText = text;
      lastTextAt = now;

      playScanSound();

      apiBusy = true;
      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
      }
    });
  }

  // ====== Search / GAS JSONP ======

  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({ action: "search", query });
      if (!res || !res.ok) throw new Error(res?.error || "API Error");

      const htmlString = res.html || "";
      if (!htmlString) {
        playErrorSound();
        await Swal.fire({
          icon:'error',
          title:'ไม่พบข้อมูล',
          text:'กรุณาตรวจสอบข้อมูลการค้นหาอีกครั้ง',
          confirmButtonText:'OK',
          allowOutsideClick:false
        });
        searchInput.value = '';
        return;
      }

      // highlight
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      const rows = doc.getElementsByTagName('tr');

      for (const row of rows) {
        const th = row.getElementsByTagName('th')[0];
        if (!th) continue;

        if (th.innerText === 'Timestamp') {
          th.style.backgroundColor = '#FFFF99';
          const td = row.getElementsByTagName('td')[0]; if (td) td.style.backgroundColor = '#FFFF99';
        }
        if (th.innerText === 'Timestamp Out') {
          th.style.backgroundColor = '#00FFFF';
          const td = row.getElementsByTagName('td')[0]; if (td) td.style.backgroundColor = '#00FFFF';
        }
      }

      await Swal.fire({
        title: 'ข้อมูล',
        html: doc.body.innerHTML,
        confirmButtonText: 'OK',
        showCloseButton: true,
        allowOutsideClick: false,
        timer: 5000
      });

      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      await Swal.fire({
        icon:'error',
        title:'Error',
        text: String(err?.message || err),
        confirmButtonText:'OK',
        allowOutsideClick:false
      });

      // auto restart only if camera is off (avoid repeated permission prompts)
      setTimeout(() => {
        if (!cameraStarted && permissionState !== "denied") startFlow_().catch(()=>{});
      }, AUTO_RESTART_MS);
    }
  }

  function gasJsonp(params) {
    return new Promise((resolve, reject) => {
      if (!GAS_WEBAPP_URL) return reject(new Error("ยังไม่ได้ตั้งค่า GAS_WEBAPP_URL"));

      const cbName = "__gas_cb_" + Math.random().toString(36).slice(2);
      const url = GAS_WEBAPP_URL + "?" + toQuery({ ...params, callback: cbName, _ts: Date.now() });

      const script = document.createElement("script");
      script.src = url;
      script.async = true;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timeout เรียก Apps Script"));
      }, API_LOCK_TIMEOUT);

      window[cbName] = (data) => {
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };

      script.onerror = () => {
        clearTimeout(timer);
        cleanup();
        reject(new Error("เรียก Apps Script ไม่สำเร็จ (network/script error)"));
      };

      function cleanup() {
        try { delete window[cbName]; } catch(_) { window[cbName] = undefined; }
        if (script && script.parentNode) script.parentNode.removeChild(script);
      }

      document.body.appendChild(script);
    });
  }

  function toQuery(obj) {
    const usp = new URLSearchParams();
    Object.keys(obj || {}).forEach(k => {
      const v = obj[k];
      if (v === undefined || v === null) return;
      usp.set(k, String(v));
    });
    return usp.toString();
  }

  function playScanSound() {
    const s = document.getElementById('scanSound');
    if (s) { s.volume = 1.0; s.play().catch(()=>{}); }
  }

  function playErrorSound() {
    const s = document.getElementById('errorSound');
    if (s) { s.volume = 1.0; s.play().catch(()=>{}); }
  }
});
