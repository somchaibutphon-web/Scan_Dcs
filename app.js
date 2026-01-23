// =============================
// GAS Web App URL (/exec)
// =============================
const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbxTalJy8NES5PwLMqBgKtpAB9-QvqNIfIyWpm7oXzz0fcOETzrCUD28UgritPz5ZT7TDA/exec";

// ===== Scan / API behavior =====
const SCAN_COOLDOWN_MS   = 800;
const SAME_CODE_HOLD_MS  = 1800;
const API_LOCK_TIMEOUT   = 15000;

// ✅ Auto-stop camera if idle
const CAMERA_IDLE_TIMEOUT_MS = 30000; // 30s

document.addEventListener('DOMContentLoaded', () => {
  // ===== PWA: Service Worker =====
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  }

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
  let decoding = false;
  let apiBusy = false;

  let lastScanAt = 0;
  let lastText = "";
  let lastTextAt = 0;

  let activeStream = null;

  // ✅ กันเปิดซ้อน + กัน permission เด้งซ้ำ
  let starting = false;          // กันกดเปิดกล้องซ้อน
  let cameraSessionLocked = false; // ถ้าเปิดสำเร็จแล้ว จะไม่เรียก getUserMedia ซ้ำจนกว่าจะ stop

  // ✅ ถ้า user เคย deny จริง เราจะไม่พยายามเด้งซ้ำ
  let hardDenied = false;

  // ✅ Idle timer
  let idleTimer = null;
  function bumpIdle_(reason = "") {
    if (!cameraStarted) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopCamera(true);
    }, CAMERA_IDLE_TIMEOUT_MS);
  }

  // ========= Toast =========
  const Toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    showCloseButton: true,
    timer: 6000,
    timerProgressBar: true,
    didOpen: (toast) => {
      toast.addEventListener('mouseenter', Swal.stopTimer);
      toast.addEventListener('mouseleave', Swal.resumeTimer);
    }
  });

  function esc(s){
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
      .replace(/'/g,'&#039;');
  }

  function toastInfo(title, html, ms=4200){
    bumpIdle_("toast");
    Toast.fire({ icon:'info', title: `<b>${esc(title)}</b>`, html, timer: ms });
  }
  function toastOk(title, html, ms=5200){
    bumpIdle_("toast");
    Toast.fire({ icon:'success', title: `<b>${esc(title)}</b>`, html, timer: ms });
  }
  function toastWarn(title, html, ms=5200){
    bumpIdle_("toast");
    Toast.fire({ icon:'warning', title: `<b>${esc(title)}</b>`, html, timer: ms });
  }
  function toastErr(title, html, ms=6500){
    bumpIdle_("toast");
    Toast.fire({ icon:'error', title: `<b>${esc(title)}</b>`, html, timer: ms });
  }

  function showScanToast(data){
    // data: {autoId, tsIn, dc, dcName, fullName, gender, company, phone, tsOut, duration}
    const lines = [
      data.tsIn ? `Timestamp: ${data.tsIn}` : null,
      (data.dc || data.dcName) ? `DC: ${data.dc || ''}${data.dcName ? ' - ' + data.dcName : ''}` : null,
      data.fullName ? `ชื่อ: ${data.fullName}` : null,
      data.company ? `บริษัท: ${data.company}` : null,
      data.phone ? `โทร: ${data.phone}` : null,
      data.tsOut ? `Timestamp Out: ${data.tsOut}` : null,
      data.duration ? `Duration: ${data.duration}` : null,
    ].filter(Boolean);

    const show = lines.slice(0, 6).map(x => `<div style="font-size:12px;line-height:1.25;opacity:.95">${esc(x)}</div>`).join('');
    const more = Math.max(0, lines.length - 6);

    toastOk(
      `บันทึกสำเร็จ • ${data.autoId || '-'}`,
      `<div style="text-align:left;min-width:260px;max-width:360px">
        ${show ? `<div style="margin-top:4px">${show}</div>` : ''}
        ${more ? `<div style="margin-top:6px;font-size:11px;opacity:.75">+ เพิ่มอีก ${more} รายการ</div>` : ''}
      </div>`
    );
  }

  // ========= UX =========
  window.onclick = (e) => { if (e.target.id !== 'cameraSelect') searchInput.focus(); };

  searchInput.addEventListener('input', () => {
    searchInput.value = searchInput.value.toUpperCase();
    bumpIdle_("typing");
  });

  searchBtn.addEventListener('click', () => {
    bumpIdle_("searchBtn");
    runSearch(searchInput.value);
  });

  searchInput.addEventListener('keyup', (e) => {
    bumpIdle_("typing");
    if (e.key === 'Enter') runSearch(searchInput.value);
  });

  startButton.addEventListener('click', async () => {
    if (starting) return;
    starting = true;
    try {
      await startCameraFlow_();
    } finally {
      starting = false;
    }
  });

  stopButton.addEventListener('click', () => stopCamera(false));

  cameraSelect.addEventListener('change', async () => {
    if (!cameraStarted) return;
    bumpIdle_("changeCam");
    // ✅ สลับกล้อง = stop แล้วค่อย open ใหม่ (แต่ยังกัน permission เด้งด้วย lock)
    await restartWithDevice_(cameraSelect.value);
  });

  // ========= Helpers =========
  function isMobile_() {
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }

  function isInAppBrowser_() {
    const ua = navigator.userAgent || "";
    return /Line|FBAN|FBAV|Instagram/i.test(ua);
  }

  async function listVideoDevices_() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === "videoinput");
  }

  function pickDefaultDevice_(devices) {
    if (!devices?.length) return "";
    if (isMobile_()) {
      const back = devices.find(d => /back|rear|environment/i.test(d.label || ""));
      return (back?.deviceId) || devices[0].deviceId;
    }
    return devices[0].deviceId;
  }

  async function refreshCameraSelect_() {
    // NOTE: label จะมาเต็มหลัง permission
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

    cameraSelect.style.display = (cams.length <= 1) ? "none" : "block";
  }

  // ========= Main Flow =========
  async function startCameraFlow_() {
    if (!navigator.mediaDevices?.getUserMedia) {
      await Swal.fire({ icon:'error', title:'ไม่รองรับกล้อง', text:'เบราว์เซอร์นี้ไม่รองรับการใช้งานกล้อง', confirmButtonText:'OK' });
      return;
    }

    if (hardDenied) {
      await Swal.fire({
        icon:'warning',
        title:'สิทธิ์กล้องถูกปฏิเสธ',
        html:`<div style="text-align:left;font-size:14px">
          ระบบตรวจพบว่าเคยกด “ไม่อนุญาต” กล้องไว้<br>
          กรุณาไปเปิดสิทธิ์กล้องในตั้งค่าเบราว์เซอร์/โทรศัพท์ก่อน แล้วค่อยกลับมากด “เปิดกล้อง” อีกครั้ง
        </div>`,
        confirmButtonText:'OK',
        allowOutsideClick:false
      });
      return;
    }

    // เตือน in-app browser (บล็อก permission / เลือกกล้องไม่ได้)
    if (isInAppBrowser_()) {
      toastInfo("แนะนำ", `<div style="text-align:left;font-size:12px">
        ถ้าเปิดผ่าน LINE/FB/IG บางรุ่นจะเด้งขออนุญาตซ้ำ/เลือกกล้องไม่ได้<br>
        แนะนำเปิดด้วย Chrome/Safari หรือ Add to Home Screen
      </div>`, 5200);
    }

    // ✅ ถ้า session lock และ stream ยัง live → ไม่เรียก getUserMedia ซ้ำ (แก้เด้ง permission)
    if (cameraSessionLocked && activeStream && activeStream.getTracks().some(t => t.readyState === "live")) {
      cameraStarted = true;
      bumpIdle_("resume");
      resumeDecode_();
      return;
    }

    // เปิดกล้องจริง (ครั้งเดียวต่อ session จน stop)
    try {
      await openCameraOnce_();
      cameraSessionLocked = true; // ✅ lock เมื่อเปิดสำเร็จ
    } catch (err) {
      const name = err?.name || "CameraError";
      console.error(err);

      if (name === "NotAllowedError" || name === "SecurityError") {
        // ✅ ถือว่า hardDenied เพื่อไม่เด้งซ้ำ
        hardDenied = true;
        await Swal.fire({
          icon:'warning',
          title:'ไม่ได้รับอนุญาตใช้กล้อง',
          html:`<div style="text-align:left;font-size:14px">
            กรุณาอนุญาตกล้องในการตั้งค่า แล้วลองใหม่<br><br>
            • iPhone: Settings → Safari/Chrome → Camera → Allow<br>
            • Android: Site settings → Camera → Allow
          </div>`,
          confirmButtonText:'OK',
          allowOutsideClick:false
        });
        return;
      }

      let msg = "ไม่สามารถเปิดกล้องได้";
      if (name === "NotFoundError") msg = "ไม่พบกล้องในอุปกรณ์นี้";
      if (name === "NotReadableError") msg = "กล้องถูกใช้งานโดยแอปอื่นอยู่ (ปิดแอป/แท็บอื่นก่อน)";
      if (name === "OverconstrainedError") msg = "เลือกกล้อง/ความละเอียดที่อุปกรณ์ไม่รองรับ";

      await Swal.fire({ icon:'error', title:'เปิดกล้องไม่สำเร็จ', text: msg, confirmButtonText:'OK' });
      return;
    }

    // หลังได้ permission แล้ว refresh list
    try { await refreshCameraSelect_(); } catch (_) {}

    cameraStarted = true;
    bumpIdle_("start");
    resumeDecode_();
    toastInfo("กล้องพร้อมใช้งาน", `<div style="font-size:12px;text-align:left">สแกนต่อเนื่องได้เลย (จะปิดอัตโนมัติถ้าไม่ใช้งาน 30 วินาที)</div>`, 2800);
  }

  async function openCameraOnce_() {
    await stopCamera(true);

    const tryOpen = async (constraints) => {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      activeStream = stream;
      qrVideo.srcObject = stream;
      await qrVideo.play();
      return true;
    };

    const wantDeviceId = cameraSelect.value || currentDeviceId || "";

    // ✅ ลำดับ fallback ที่ “ปลอดภัย” สำหรับหลายรุ่น
    // 1) exact deviceId
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

    // 2) facingMode environment (mobile)
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

    // 3) let browser choose
    await tryOpen({ video: true, audio: false });
  }

  async function restartWithDevice_(deviceId) {
    // สลับกล้อง = เปิดใหม่หนึ่งครั้ง (lock ยังอยู่)
    currentDeviceId = deviceId || currentDeviceId || "";
    try {
      // ระวัง: บางเครื่องสลับแล้วเด้ง permission ถ้าเราขอใหม่รัว → ทำแบบ stop/open ครั้งเดียวพอ
      await openCameraOnce_();
      cameraSessionLocked = true;
      cameraStarted = true;
      bumpIdle_("restart");
      resumeDecode_();
    } catch (err) {
      cameraStarted = false;
      toastErr("สลับกล้องไม่สำเร็จ", `<div style="font-size:12px;text-align:left">ลองปิดกล้องแล้วเปิดใหม่ หรือเลือกกล้องอีกครั้ง</div>`);
    }
  }

  async function stopCamera(fromIdle) {
    apiBusy = false;
    cameraStarted = false;
    decoding = false;

    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    try { codeReader.reset(); } catch (_) {}

    if (activeStream) {
      try { activeStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }
    activeStream = null;

    try { qrVideo.pause(); } catch (_) {}
    qrVideo.srcObject = null;

    // ✅ ปลด lock เมื่อ stop จริงเท่านั้น (เพื่อไม่เรียก getUserMedia ซ้ำแบบงงๆ)
    cameraSessionLocked = false;

    if (fromIdle) {
      toastInfo("ปิดกล้องอัตโนมัติ", `<div style="font-size:12px;text-align:left">ไม่มีการใช้งานเกิน 30 วินาที ระบบปิดกล้องให้เพื่อประหยัดแบตเตอรี่</div>`, 2600);
    }
  }

  // ========= Decode =========
  function pauseDecode_() {
    decoding = false;
    try { codeReader.reset(); } catch (_) {}
  }

  function resumeDecode_() {
    if (!cameraStarted) return;
    if (decoding) return;
    decoding = true;
    decodeLoop_(currentDeviceId || null);
  }

  function decodeLoop_(deviceIdOrNull) {
    try { codeReader.reset(); } catch (_) {}

    codeReader.decodeFromVideoDevice(deviceIdOrNull, qrVideo, async (result, err) => {
      if (!decoding) return;
      if (!result) return;

      bumpIdle_("scan");
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

      // ✅ พัก decode ระหว่างยิง API แล้วกลับมาสแกนต่อ
      apiBusy = true;
      pauseDecode_();

      try {
        await runSearch(text);
      } finally {
        apiBusy = false;
        bumpIdle_("afterApi");
        resumeDecode_();
      }
    });
  }

  // ========= GAS JSONP =========
  async function runSearch(query) {
    query = String(query || "").trim().toUpperCase();
    if (!query) return;

    try {
      const res = await gasJsonp({ action: "search", query });
      if (!res || !res.ok) throw new Error(res?.error || "API Error");

      const htmlString = res.html || "";
      if (!htmlString) {
        playErrorSound();
        toastWarn("ไม่พบข้อมูล", `<div style="font-size:12px;text-align:left"><b>Auto ID:</b> ${esc(query)}<br>กรุณาตรวจสอบอีกครั้ง</div>`);
        searchInput.value = '';
        return;
      }

      // แปลงตารางเป็น map
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlString, 'text/html');
      const rows = Array.from(doc.querySelectorAll('tr'));

      const map = {};
      rows.forEach(r => {
        const th = r.querySelector('th');
        const td = r.querySelector('td');
        if (!th || !td) return;
        const k = (th.innerText || '').trim();
        const v = (td.innerText || '').trim();
        if (k) map[k] = v;
      });

      // map ตามหัวตารางของคุณ
      const data = {
        autoId: map['Auto ID'] || query,
        tsIn: map['Timestamp'] || '',
        dc: map['DC'] || '',
        dcName: map['DC Name'] || '',
        fullName: map['ชื่อ-นามสกุล'] || '',
        gender: map['เพศ'] || '',
        company: map['ชื่อบริษัท/ต้นสังกัด'] || '',
        phone: map['เบอร์โทร'] || '',
        tsOut: map['Timestamp Out'] || '',
        duration: map['Duration'] || ''
      };

      showScanToast(data);
      searchInput.value = '';

    } catch (err) {
      console.error(err);
      playErrorSound();
      toastErr("Error", `<div style="font-size:12px;text-align:left"><b>Auto ID:</b> ${esc(query)}<br>${esc(String(err?.message || err))}</div>`);
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
