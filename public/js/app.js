// =============================================
//  VR CLASSROOM — Main Application
// =============================================

// --- Global State ---
let scene, camera, renderer, controls;
let ws = null;
let myId = null, myRole = null, mySeat = -1, myName = '';
let handRaised = false;

// Keyboard movement state
const keysDown = new Set();

// Room boundaries — camera cannot leave these limits (mouse, zoom, or arrow keys)
const CAM_BOUNDS = { xMin: -11, xMax: 11, yMin: 0.8, yMax: 14, zMin: -15, zMax: 22 };

// 3D Object References
let boardMesh = null;
let boardCanvas = null, boardCtx = null, boardTexture = null;
let avatarGroups = {}; // id -> THREE.Group
let seatOccupied = {}; // seatIndex -> true/false
let teacherAvatarGroup = null;
let teacherPointer = null; // animated pointer stick
let classroomState = { boardLetters: [], currentHighlight: -1, teacher: null, students: [] };

// Board font size (synced via server)
const FONT_SIZES = { small: 56, medium: 80, large: 112 };
let boardFontSize = 56;

// Board scroll state (teacher only — how many lines scrolled up from latest)
let boardScrollLines = 0;

// WebRTC audio
let localStream    = null;
let micMuted       = false;
const peerConns    = {};   // peerId -> RTCPeerConnection
const peerAudioEls = {};   // peerId -> <audio>
const iceBuf       = {};   // peerId -> [RTCIceCandidate] buffered before remote desc
const RTC_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Seat layout: 4 rows x 5 cols  (rows at z = -6, -1.5, 3, 7.5)
const SEATS = [];
for (let row = 0; row < 4; row++) {
  for (let col = 0; col < 5; col++) {
    SEATS.push({ x: -6 + col * 3, z: -6 + row * 4.5, row, col, index: row * 5 + col });
  }
}

// =============================================
//  ENTRY POINT — Join classroom
// =============================================
function joinAs(role) {
  const nameInput = document.getElementById('name-input');
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); nameInput.style.borderColor = '#f44336'; return; }
  nameInput.style.borderColor = '';

  myRole = role;
  myName = name;

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';

  document.getElementById('user-name-display').textContent = name;
  const badge = document.getElementById('role-badge');
  badge.textContent = role === 'teacher' ? '👩‍🏫 Teacher' : '🧑‍🎓 Student';
  badge.className = `badge badge-${role}`;

  if (role === 'teacher') {
    document.getElementById('teacher-panel').style.display = 'block';
    document.getElementById('cam-teacher-view').style.display = 'block';
    document.getElementById('cam-atboard').style.display = 'block';
    buildKeyboard();
  } else {
    document.getElementById('student-panel').style.display = 'block';
    document.getElementById('cam-my-seat').style.display = 'block';
  }

  initThreeJS();
  connectWebSocket();
  initAudio();
}

// =============================================
//  WEBSOCKET
// =============================================
function connectWebSocket() {
  const host = window.location.host;
  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${host}`);

  ws.onopen = () => {
    setStatus(true);
    ws.send(JSON.stringify({ type: 'join', name: myName, role: myRole }));
  };

  ws.onclose = () => setStatus(false);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'joined':
        myId = msg.id;
        mySeat = msg.seat;
        if (myRole === 'student') {
          const seat = SEATS[mySeat];
          document.getElementById('seat-info').textContent =
            seat ? `Seat: Row ${seat.row + 1}, Col ${seat.col + 1}` : '';
        }
        break;
      case 'classroom_state':
        classroomState = msg;
        updateClassroomState(msg);
        break;
      case 'chat_message':
        appendChat(msg);
        break;
      case 'rtc_signal':
        handleRtcSignal(msg.from, msg.signal);
        break;
    }
  };
}

function setStatus(online) {
  document.getElementById('status-dot').className = `status-dot${online ? '' : ' disconnected'}`;
  document.getElementById('status-text').textContent = online ? 'Connected' : 'Disconnected';
}

// =============================================
//  THREE.JS INIT
// =============================================
function initThreeJS() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0x87CEEB);
  document.getElementById('canvas-container').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 200);

  // Behind and above the room — all 4 rows + board visible on login
  camera.position.set(0, 9, 16);
  camera.lookAt(0, 1.5, -1);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.5, -1);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI / 2 - 0.02;
  controls.minDistance = 3;
  controls.maxDistance = 50;
  controls.zoomSpeed = 0.5;
  controls.update();

  buildClassroomScene();
  // Student: face the board and teacher on login; Teacher: start at their position
  setCameraView(myRole === 'teacher' ? 'teacher' : 'studentfront');

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  window.addEventListener('keydown', (e) => {
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
      e.preventDefault();
      keysDown.add(e.key);
    }
  });
  window.addEventListener('keyup', (e) => keysDown.delete(e.key));

  animate();
}

function applyKeyMovement() {
  if (keysDown.size === 0) return;
  const speed = 0.12;
  let dx = 0, dz = 0;
  if (keysDown.has('ArrowLeft'))  dx = -speed;
  if (keysDown.has('ArrowRight')) dx =  speed;
  if (keysDown.has('ArrowUp'))    dz = -speed;
  if (keysDown.has('ArrowDown'))  dz =  speed;
  camera.position.x += dx;
  camera.position.z += dz;
  controls.target.x += dx;
  controls.target.z += dz;
}

// Clamp camera after every controls.update() — catches mouse pan, orbit, zoom, and arrow keys
function clampCameraToRoom() {
  const p = camera.position;
  const cx = Math.min(CAM_BOUNDS.xMax, Math.max(CAM_BOUNDS.xMin, p.x));
  const cy = Math.min(CAM_BOUNDS.yMax, Math.max(CAM_BOUNDS.yMin, p.y));
  const cz = Math.min(CAM_BOUNDS.zMax, Math.max(CAM_BOUNDS.zMin, p.z));
  if (cx !== p.x || cy !== p.y || cz !== p.z) {
    const dx = cx - p.x, dy = cy - p.y, dz = cz - p.z;
    camera.position.set(cx, cy, cz);
    controls.target.x += dx;
    controls.target.y += dy;
    controls.target.z += dz;
    controls.update();
  }
}

function animate() {
  requestAnimationFrame(animate);
  applyKeyMovement();
  controls.update();
  clampCameraToRoom();
  animateAvatars();
  renderer.render(scene, camera);
}

// =============================================
//  CAMERA PRESETS
// =============================================
// Room layout (w=20, h=6.5, d=28):
//   Front wall (board) : z = -14
//   Teacher position   : z = -12  (between board and students)
//   Student rows       : z = -3, 1.5, 6, 10.5
//   Back wall          : z = +14

function setCameraView(view) {
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.remove('active'));
  if (event && event.target && event.target.classList) event.target.classList.add('active');

  controls.enabled = true;

  if (view === 'overview') {
    // Diagonal corner — whole room visible
    moveCameraTo(new THREE.Vector3(18, 15, 18), new THREE.Vector3(0, 2, 0));

  } else if (view === 'studentfront') {
    // Behind last row (z≈7.5) looking toward board — all rows + teacher visible
    moveCameraTo(new THREE.Vector3(0, 4.5, 12), new THREE.Vector3(0, 3, -13));

  } else if (view === 'board') {
    // Close-up of blackboard from mid-room
    moveCameraTo(new THREE.Vector3(0, 5, 2), new THREE.Vector3(0, 3.6, -13.8));

  } else if (view === 'back') {
    // From back corner looking toward board
    moveCameraTo(new THREE.Vector3(-8, 9, 16), new THREE.Vector3(0, 2, -1));

  } else if (view === 'atboard') {
    // Side angle: teacher at board with all students behind
    moveCameraTo(new THREE.Vector3(16, 7, 0), new THREE.Vector3(0, 2, -9));

  } else if (view === 'myseat' && myRole === 'student' && mySeat >= 0) {
    const s = SEATS[mySeat];
    if (s) {
      // Eye-level from seat looking toward board
      moveCameraTo(new THREE.Vector3(s.x, 2.8, s.z + 1.5), new THREE.Vector3(0, 2.0, -13));
    }

  } else if (view === 'teacher' && myRole === 'teacher') {
    // Full-room overview from back: board visible, teacher faces camera (=faces students), all rows in frame
    moveCameraTo(new THREE.Vector3(0, 8, 11), new THREE.Vector3(0, 2, -1));
  }
}

function moveCameraTo(pos, target) {
  controls.target.copy(target);
  camera.position.copy(pos);
  camera.lookAt(target);
  controls.update();
}

// =============================================
//  BUILD CLASSROOM SCENE
// =============================================
function buildClassroomScene() {
  setupLighting();
  buildRoom();
  buildBlackboard();
  buildTeacherDesk();
  buildStudentDesks();
  buildWindowsAndDoor();
  buildDecorations();
  buildTeacherAvatar();
}

// --- Lighting ---
function setupLighting() {
  // Ambient
  scene.add(new THREE.AmbientLight(0xfff8e7, 0.55));

  // Sun through windows
  const sun = new THREE.DirectionalLight(0xfff5c0, 0.9);
  sun.position.set(-8, 12, 4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 50;
  sun.shadow.camera.left = -18;
  sun.shadow.camera.right = 18;
  sun.shadow.camera.top = 14;
  sun.shadow.camera.bottom = -14;
  sun.shadow.bias = -0.001;
  scene.add(sun);

  // 4 ceiling lights (adjusted for h=6.5)
  const lightPositions = [[-5, 5.5, -6], [5, 5.5, -6], [-5, 5.5, 6], [5, 5.5, 6]];
  lightPositions.forEach(([x, y, z]) => {
    const pt = new THREE.PointLight(0xfff8e7, 0.7, 16);
    pt.position.set(x, y, z);
    pt.castShadow = true;
    pt.shadow.mapSize.set(512, 512);
    scene.add(pt);
  });

  // Soft wide fill lights flanking the board — no spotlight glare
  const fillL = new THREE.PointLight(0xfff8e7, 0.6, 14);
  fillL.position.set(-5, 5, -10);
  scene.add(fillL);
  const fillR = new THREE.PointLight(0xfff8e7, 0.6, 14);
  fillR.position.set(5, 5, -10);
  scene.add(fillR);
}

// --- Room Shell ---
function buildRoom() {
  const w = 20, h = 6.5, d = 28;

  const floorMat = new THREE.MeshPhongMaterial({ color: 0x9c7040, shininess: 40 });
  const wallMat  = new THREE.MeshPhongMaterial({ color: 0xfaf0e6, shininess: 5 });

  // Floor with tile lines
  const floor = makeMesh([w, 0.12, d], floorMat, [0, -0.06, 0]);
  floor.receiveShadow = true;
  scene.add(floor);

  // Floor tiles overlay (dark lines)
  const tileLineMat = new THREE.MeshPhongMaterial({ color: 0x7a5530, shininess: 20 });
  for (let xi = -9; xi <= 9; xi += 2) {
    scene.add(makeMesh([0.04, 0.01, d], tileLineMat, [xi, 0.005, 0]));
  }
  for (let zi = -13; zi <= 13; zi += 2) {
    scene.add(makeMesh([w, 0.01, 0.04], tileLineMat, [0, 0.005, zi]));
  }

  // Ceiling — PlaneGeometry with normal pointing DOWN so it is visible from inside
  // but back-face culled when any camera rises above h, leaving overview views unobstructed
  const ceilMat2 = new THREE.MeshPhongMaterial({ color: 0xf2f0eb, shininess: 2 });
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilMat2);
  ceiling.rotation.x = Math.PI / 2;   // flip normal to face –y (downward into room)
  ceiling.position.set(0, h - 0.01, 0);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  // Ceiling tile grid lines
  const ctMat = new THREE.MeshPhongMaterial({ color: 0xd8d4cc });
  for (let xi = -8; xi <= 8; xi += 4) {
    const tl = new THREE.Mesh(new THREE.PlaneGeometry(0.04, d), ctMat);
    tl.rotation.x = Math.PI / 2;
    tl.position.set(xi, h - 0.005, 0);
    scene.add(tl);
  }
  for (let zi = -12; zi <= 12; zi += 4) {
    const tl = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.04), ctMat);
    tl.rotation.x = Math.PI / 2;
    tl.position.set(0, h - 0.005, zi);
    scene.add(tl);
  }

  // Back wall: low baseboard only (camera sits outside room to see whole interior)
  addWall([w, 0.3, 0.18], [0, 0.15, d/2], wallMat);

  // Front wall: narrow side strips (board is 15 wide in 20-wide room = 2.5 each side)
  addWall([2.5, h, 0.18], [-8.75, h/2, -d/2], wallMat);   // left of board
  addWall([2.5, h, 0.18], [8.75, h/2, -d/2], wallMat);    // right of board
  addWall([w, 0.7, 0.18], [0, h - 0.35, -d/2], wallMat); // top strip (board reaches y≈6.0)
  addWall([w, 1.6, 0.18], [0, 0.8, -d/2], wallMat);      // bottom strip (board starts y≈1.6)

  // Left wall
  addWall([0.18, h, d], [-w/2, h/2, 0], wallMat);
  // Right wall
  addWall([0.18, h, d], [w/2, h/2, 0], wallMat);

  // Skirting boards
  const skirtMat = new THREE.MeshPhongMaterial({ color: 0xd4a96a });
  addWall([w, 0.12, 0.06], [0, 0.06, d/2 - 0.12], skirtMat);
  addWall([w, 0.12, 0.06], [0, 0.06, -d/2 + 0.12], skirtMat);
  addWall([0.06, 0.12, d], [-w/2 + 0.12, 0.06, 0], skirtMat);
  addWall([0.06, 0.12, d], [w/2 - 0.12, 0.06, 0], skirtMat);

  // Ceiling light fixtures (4 pairs, adjusted for larger room)
  const fixtureMat = new THREE.MeshPhongMaterial({ color: 0xeeeee0, emissive: 0xffffcc, emissiveIntensity: 0.4 });
  const hangMat = new THREE.MeshPhongMaterial({ color: 0xaaaaaa });
  [[-5, -6], [-5, 6], [5, -6], [5, 6]].forEach(([fx, fz]) => {
    scene.add(makeMesh([1.4, 0.08, 0.55], fixtureMat, [fx, h - 0.1, fz]));
    scene.add(makeMesh([0.04, 0.34, 0.04], hangMat, [fx, h - 0.38, fz]));
  });
}

function addWall(size, pos, mat) {
  const w = makeMesh(size, mat, pos);
  w.castShadow = true;
  w.receiveShadow = true;
  scene.add(w);
}

// --- Blackboard ---
function buildBlackboard() {
  // Large wood frame — 15.6 wide × 6.2 tall, spans near-floor to near-ceiling
  const frameMat = new THREE.MeshPhongMaterial({ color: 0x5d3a1a });
  scene.add(makeMesh([15.6, 6.2, 0.12], frameMat, [0, 3.4, -13.93]));

  // Board surface — high-res canvas for crisp chalk text
  boardCanvas = document.createElement('canvas');
  boardCanvas.width  = 2048;
  boardCanvas.height = 800;
  boardCtx = boardCanvas.getContext('2d');
  drawBoard([]);

  boardTexture = new THREE.CanvasTexture(boardCanvas);
  const boardMat = new THREE.MeshPhongMaterial({
    map: boardTexture,
    emissiveMap: boardTexture,
    emissive: new THREE.Color(0x334433),
    emissiveIntensity: 0.45,
    shininess: 6
  });
  boardMesh = makeMesh([15.0, 5.8, 0.05], boardMat, [0, 3.4, -13.89]);
  boardMesh.castShadow = false;
  scene.add(boardMesh);

  // Chalk ledge (sits at base of board, board bottom now at y ≈ 0.5)
  const ledgeMat = new THREE.MeshPhongMaterial({ color: 0x5d3a1a });
  scene.add(makeMesh([15.6, 0.12, 0.20], ledgeMat, [0, 0.56, -13.85]));

  // Chalks on ledge
  const chalkColors = [0xffffff, 0xffcc88, 0xff8888, 0x88ddff, 0xaaffaa, 0xffaaff];
  chalkColors.forEach((c, i) => {
    scene.add(makeMesh([0.07, 0.07, 0.55],
      new THREE.MeshPhongMaterial({ color: c }), [-3.0 + i * 0.26, 0.66, -13.8]));
  });

  // Eraser
  scene.add(makeMesh([0.28, 0.1, 0.1],
    new THREE.MeshPhongMaterial({ color: 0xcc8888 }), [5.5, 0.66, -13.8]));

  // Pointer stick (teacher tool)
  teacherPointer = new THREE.Group();
  const stick = makeMesh([0.05, 2.0, 0.05], new THREE.MeshPhongMaterial({ color: 0x7b3f00 }), [0, 0, 0]);
  const tip = makeMesh([0.08, 0.08, 0.08], new THREE.MeshPhongMaterial({ color: 0xff4444 }), [0, -1.0, 0]);
  teacherPointer.add(stick, tip);
  teacherPointer.position.set(6.5, 3.4, -13.82);
  teacherPointer.visible = false;
  scene.add(teacherPointer);
}

function drawBoard(letters, highlight = -1) {
  const W = 2048, H = 800;
  const ctx = boardCtx;

  // Rich dark-green chalkboard background
  ctx.fillStyle = '#1e4620';
  ctx.fillRect(0, 0, W, H);

  // Subtle chalk smear texture
  ctx.globalAlpha = 0.04;
  for (let i = 0; i < 80; i++) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.random() * W, Math.random() * H, Math.random() * 120 + 30, 3);
  }
  ctx.globalAlpha = 1;

  if (letters.length === 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = 'italic 38px "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Waiting for teacher to begin...', W / 2, H / 2);
    boardTexture && (boardTexture.needsUpdate = true);
    return;
  }

  const fontSize = boardFontSize;
  const lineH   = Math.round(fontSize * 1.35);
  const marginL = 28;
  const marginT = 20;
  const marginB = 16;
  const maxX    = W - 28;

  ctx.font = `bold ${fontSize}px "Courier New", monospace`;
  ctx.textAlign    = 'left';
  ctx.textBaseline = 'top';

  const charW  = ctx.measureText('M').width;
  const spaceW = charW * 0.55;

  // Pass 1 — compute total content height
  let px = marginL, py = marginT;
  letters.forEach(letter => {
    if (letter === '\n') { px = marginL; py += lineH; return; }
    const adv = letter === ' ' ? spaceW : charW;
    if (px + adv > maxX) { px = marginL; py += lineH; }
    if (letter === ' ') px += spaceW; else px += charW + 2;
  });
  const maxScrollY    = Math.max(0, py + fontSize + marginB - H);
  const maxScrollLines = Math.floor(maxScrollY / lineH);

  // Clamp teacher scroll offset to valid range
  boardScrollLines = Math.max(0, Math.min(boardScrollLines, maxScrollLines));

  // scrollY=maxScrollY → latest lines visible; subtract offset to scroll up
  const scrollY = Math.max(0, maxScrollY - boardScrollLines * lineH);

  // Update scroll UI (teacher only)
  const scrollRow  = document.getElementById('board-scroll-row');
  const scrollInfo = document.getElementById('board-scroll-info');
  const btnUp      = document.getElementById('btn-scroll-up');
  const btnDown    = document.getElementById('btn-scroll-down');
  if (scrollRow) {
    const hasOverflow = maxScrollLines > 0;
    scrollRow.style.display = (hasOverflow && myRole === 'teacher') ? 'flex' : 'none';
    if (hasOverflow && scrollInfo) {
      scrollInfo.textContent = boardScrollLines === 0
        ? 'showing latest'
        : `↑ ${boardScrollLines} line${boardScrollLines !== 1 ? 's' : ''} up`;
    }
    if (btnUp)   btnUp.disabled   = boardScrollLines >= maxScrollLines;
    if (btnDown) btnDown.disabled = boardScrollLines === 0;
  }

  // Pass 2 — render with scroll offset applied
  let x = marginL, y = marginT - scrollY;

  letters.forEach((letter, i) => {
    const isHL = i === highlight;

    if (letter === '\n') { x = marginL; y += lineH; return; }

    const advance = letter === ' ' ? spaceW : charW;
    if (x + advance > maxX) { x = marginL; y += lineH; }

    if (letter === ' ') { x += spaceW; return; }

    if (y + fontSize < 0 || y > H) { x += charW + 2; return; }

    if (isHL) {
      ctx.fillStyle = 'rgba(255,230,0,0.28)';
      ctx.fillRect(x - 2, y - 1, charW + 4, fontSize + 2);
    }

    ctx.font = `bold ${fontSize}px "Courier New", monospace`;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillText(letter, x + 2, y + 2);

    ctx.fillStyle = isHL ? '#fff176' : '#f0ede0';
    ctx.fillText(letter, x, y);

    ctx.fillStyle = '#fffef8';
    ctx.globalAlpha = 0.3;
    ctx.fillText(letter, x - 1, y - 1);
    ctx.globalAlpha = 1;

    if (isHL) {
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y + fontSize + 3);
      ctx.lineTo(x + charW, y + fontSize + 3);
      ctx.stroke();
    }

    x += charW + 2;
  });

  // Canvas indicators: show hidden-content hints on the board itself
  ctx.font = 'bold 22px sans-serif';
  ctx.textBaseline = 'top';
  if (scrollY > 0) {
    const n = Math.round(scrollY / lineH);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'left';
    ctx.fillText(`↑ ${n} line${n !== 1 ? 's' : ''} above`, marginL, 6);
  }
  if (boardScrollLines > 0) {
    const n = boardScrollLines;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textAlign = 'right';
    ctx.fillText(`↓ ${n} line${n !== 1 ? 's' : ''} below`, W - marginL, H - 28);
  }

  boardTexture && (boardTexture.needsUpdate = true);
}

// --- Teacher Desk ---
function buildTeacherDesk() {
  const woodMat  = new THREE.MeshPhongMaterial({ color: 0xb5651d, shininess: 30 });
  const darkMat  = new THREE.MeshPhongMaterial({ color: 0x7a4010, shininess: 10 });
  const blackMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });

  const tx = 0, tz = -9.5;

  // Desktop
  scene.add(makeMesh([2.6, 0.1, 1.1], woodMat, [tx, 0.85, tz]));
  // Front panel
  scene.add(makeMesh([2.6, 0.65, 0.06], darkMat, [tx, 0.52, tz - 0.52]));
  // Side panels
  scene.add(makeMesh([0.06, 0.65, 1.1], darkMat, [tx - 1.3, 0.52, tz]));
  scene.add(makeMesh([0.06, 0.65, 1.1], darkMat, [tx + 1.3, 0.52, tz]));
  // Legs
  [[-1.2, -0.42], [1.2, -0.42], [-1.2, 0.42], [1.2, 0.42]].forEach(([lx, lz]) => {
    scene.add(makeMesh([0.08, 0.82, 0.08], darkMat, [tx + lx, 0.41, tz + lz]));
  });

  // Items on desk: book, globe, apple
  scene.add(makeMesh([0.4, 0.04, 0.3], new THREE.MeshPhongMaterial({ color: 0x1a237e }), [tx - 0.6, 0.92, tz - 0.1]));
  // Globe
  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshPhongMaterial({ color: 0x3498db, shininess: 60 }));
  globe.position.set(tx + 0.7, 1.02, tz - 0.05);
  scene.add(globe);
  const globeBase = makeMesh([0.05, 0.12, 0.05], new THREE.MeshPhongMaterial({ color: 0xaaaaaa }), [tx + 0.7, 0.9, tz - 0.05]);
  scene.add(globeBase);
  // Apple
  const apple = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 10), new THREE.MeshPhongMaterial({ color: 0xe74c3c, shininess: 80 }));
  apple.position.set(tx + 0.9, 0.98, tz + 0.1);
  scene.add(apple);

}

// --- Student Desks ---
function buildStudentDesks() {
  SEATS.forEach(seat => {
    buildDeskAndChair(seat.x, seat.z);
  });
}

function buildDeskAndChair(x, z) {
  const woodMat = new THREE.MeshPhongMaterial({ color: 0xd4a96a, shininess: 20 });
  const legMat  = new THREE.MeshPhongMaterial({ color: 0x7a5530, shininess: 10 });

  // Desktop — scaled for 2.1× avatar; seat is at y=0.85 so desk top ≈ y=1.02
  const deskY   = 1.0;
  const deskW   = 2.0;
  const deskD   = 1.20;
  const deskH   = 0.10;
  const desk = makeMesh([deskW, deskH, deskD], woodMat, [x, deskY, z]);
  desk.castShadow = true;
  desk.receiveShadow = true;
  scene.add(desk);

  // Legs
  const legH = deskY - deskH / 2;
  [[-0.88, -0.51], [-0.88, 0.51], [0.88, -0.51], [0.88, 0.51]].forEach(([lx, lz]) => {
    const leg = makeMesh([0.09, legH, 0.09], legMat, [x + lx, legH / 2, z + lz]);
    leg.castShadow = true;
    scene.add(leg);
  });

  // Cross bar
  scene.add(makeMesh([1.74, 0.06, 0.06], legMat, [x, 0.38, z]));

  // Book/pencil on desk
  if (Math.random() > 0.3) {
    scene.add(makeMesh([0.38, 0.03, 0.28], new THREE.MeshPhongMaterial({ color: Math.random() > 0.5 ? 0x3498db : 0x27ae60 }), [x + (Math.random() - 0.5) * 0.5, deskY + deskH / 2 + 0.015, z - 0.05]));
  }

  // Chair pushed back so it clears the deeper desk (desk back edge at z+0.60)
  buildChair(x, z + 1.0, false);
}

function buildChair(x, z, isOffice) {
  const seatMat  = new THREE.MeshPhongMaterial({ color: isOffice ? 0x1a237e : 0x2980b9, shininess: 15 });
  const metalMat = new THREE.MeshPhongMaterial({ color: 0x888899, shininess: 60 });

  // Seat height: teacher chair keeps 0.54; student chair raised to 0.85 for 2.1× avatar
  const seatY = isOffice ? 0.54 : 0.85;
  scene.add(makeMesh([0.77, 0.08, 0.70], seatMat, [x, seatY, z]));

  // Backrest (direction matches occupant facing)
  const brZ = isOffice ? z - 0.31 : z + 0.31;
  scene.add(makeMesh([0.77, 0.84, 0.08], seatMat, [x, seatY + 0.44, brZ]));

  // Legs
  const legH = seatY - 0.04;
  [[-0.31, -0.28], [0.31, -0.28], [-0.31, 0.28], [0.31, 0.28]].forEach(([lx, lz]) => {
    const leg = makeMesh([0.056, legH, 0.056], metalMat, [x + lx, legH / 2, z + lz]);
    leg.castShadow = true;
    scene.add(leg);
  });
}

// --- Windows & Door ---
function buildWindowsAndDoor() {
  const glassMat    = new THREE.MeshPhongMaterial({ color: 0xaad4f5, transparent: true, opacity: 0.45, shininess: 90 });
  const frameMat    = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 20 });
  const windowSills = new THREE.MeshPhongMaterial({ color: 0xe0e0d0 });

  // Windows on left wall (room x=-10; z positions: -7, 0, 7)
  [-7, 0, 7].forEach(wz => {
    scene.add(makeMesh([0.14, 2.1, 1.6], frameMat, [-10.09, 3, wz]));
    scene.add(makeMesh([0.06, 1.8, 1.3], glassMat, [-10.06, 3, wz]));
    scene.add(makeMesh([0.2, 0.06, 1.7], windowSills, [-10.04, 2.04, wz]));
    scene.add(makeMesh([0.08, 1.8, 0.04], frameMat, [-10.07, 3, wz]));
    scene.add(makeMesh([0.08, 0.04, 1.3], frameMat, [-10.07, 3, wz]));
  });

  // Windows on right wall
  [-4, 3, 10].forEach(wz => {
    scene.add(makeMesh([0.14, 2.1, 1.6], frameMat, [10.09, 3, wz]));
    scene.add(makeMesh([0.06, 1.8, 1.3], glassMat, [10.06, 3, wz]));
    scene.add(makeMesh([0.2, 0.06, 1.7], windowSills, [10.04, 2.04, wz]));
  });

  // Door at back (back wall at z=14)
  const doorMat  = new THREE.MeshPhongMaterial({ color: 0x8B4513, shininess: 30 });
  const doorKnob = new THREE.MeshPhongMaterial({ color: 0xd4af37, shininess: 90 });
  scene.add(makeMesh([1.0, 2.3, 0.12], doorMat, [6.5, 1.15, 14.06]));
  scene.add(makeMesh([0.18, 0.18, 0.18], doorKnob, [5.88, 1.1, 14.06]));
  const dfMat = new THREE.MeshPhongMaterial({ color: 0xf0e0c8 });
  scene.add(makeMesh([0.12, 2.4, 0.14], dfMat, [5.96, 1.2, 14.07]));
  scene.add(makeMesh([0.12, 2.4, 0.14], dfMat, [7.04, 1.2, 14.07]));
  scene.add(makeMesh([1.2, 0.12, 0.14], dfMat, [6.5, 2.4, 14.07]));
}

// --- Decorations ---
function buildDecorations() {
  // Clock on front wall left side (wall at z=-14)
  const clockMat = new THREE.MeshPhongMaterial({ color: 0xffffff, shininess: 20 });
  const clockFace = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.06, 24), clockMat);
  clockFace.rotation.x = Math.PI / 2;
  clockFace.position.set(-7.5, 4.8, -13.9);
  scene.add(clockFace);
  const clockBorder = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.04, 8, 24), new THREE.MeshPhongMaterial({ color: 0x333333 }));
  clockBorder.rotation.x = Math.PI / 2;
  clockBorder.position.set(-7.5, 4.8, -13.87);
  scene.add(clockBorder);
  scene.add(makeMesh([0.04, 0.26, 0.02], new THREE.MeshPhongMaterial({ color: 0x111111 }), [-7.5, 4.92, -13.84]));
  scene.add(makeMesh([0.03, 0.20, 0.02], new THREE.MeshPhongMaterial({ color: 0x222222 }), [-7.62, 4.8, -13.84]));

  // Alphabet poster on right side of front wall
  const posterMat = new THREE.MeshPhongMaterial({ color: 0xfffde7 });
  scene.add(makeMesh([2.5, 1.8, 0.04], posterMat, [7.5, 3.8, -13.9]));
  scene.add(makeMesh([2.56, 0.06, 0.05], new THREE.MeshPhongMaterial({ color: 0xff5722 }), [7.5, 4.72, -13.89]));
  scene.add(makeMesh([2.56, 0.06, 0.05], new THREE.MeshPhongMaterial({ color: 0xff5722 }), [7.5, 2.92, -13.89]));

  // Bookshelf on left wall (wall at x=-10)
  const shelfMat = new THREE.MeshPhongMaterial({ color: 0x8B5E3C });
  scene.add(makeMesh([0.12, 2.5, 1.6], shelfMat, [-9.9, 1.5, -4]));
  scene.add(makeMesh([0.06, 0.06, 1.6], shelfMat, [-9.87, 0.6, -4]));
  scene.add(makeMesh([0.06, 0.06, 1.6], shelfMat, [-9.87, 1.4, -4]));
  scene.add(makeMesh([0.06, 0.06, 1.6], shelfMat, [-9.87, 2.2, -4]));
  const bookColors = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf39c12, 0x9b59b6, 0x1abc9c];
  bookColors.forEach((c, i) => {
    scene.add(makeMesh([0.06, 0.65, 0.14], new THREE.MeshPhongMaterial({ color: c }), [-9.86, 1.05, -4.5 + i * 0.22]));
  });

  // Notice board on back wall (z=14)
  const boardBg = new THREE.MeshPhongMaterial({ color: 0xd4a26b });
  scene.add(makeMesh([3, 1.8, 0.06], boardBg, [-4, 3.5, 13.92]));
  const boardFrame = new THREE.MeshPhongMaterial({ color: 0x7a4010 });
  scene.add(makeMesh([3.1, 0.08, 0.08], boardFrame, [-4, 4.45, 13.93]));
  scene.add(makeMesh([3.1, 0.08, 0.08], boardFrame, [-4, 2.62, 13.93]));
  [[0.6, 3.2], [0.6, 0.8], [0.35, 2.0]].forEach(([ph, pw]) => {
    scene.add(makeMesh([pw, ph, 0.02], new THREE.MeshPhongMaterial({ color: 0xffffff }), [-4 + (Math.random() - 0.5) * 1.5, 3.4 + (Math.random() - 0.5) * 0.8, 13.95]));
  });

  // Plant in back corner (z=13)
  const potMat = new THREE.MeshPhongMaterial({ color: 0xc0632a });
  scene.add(makeMesh([0.3, 0.35, 0.3], potMat, [-9.5, 0.175, 13]));
  const stemMat = new THREE.MeshPhongMaterial({ color: 0x2e7d32 });
  [0, 0.3, 0.6].forEach(h => {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), stemMat);
    leaf.position.set(-9.5 + (h === 0 ? 0 : (h === 0.3 ? -0.12 : 0.1)), 0.42 + h, 13);
    scene.add(leaf);
  });

  // "WELCOME" mat at door
  scene.add(makeMesh([0.8, 0.02, 0.5], new THREE.MeshPhongMaterial({ color: 0x4caf50 }), [6.5, 0.01, 13.3]));

  // Row number signs on desk ends
  ['1', '2', '3', '4'].forEach((n, i) => {
    const sign = makeTextSprite(`Row ${n}`, 0.5);
    sign.position.set(-9.5, 1.2, -3 + i * 4.5);
    scene.add(sign);
  });
}

// --- Teacher Avatar ---
function buildTeacherAvatar() {
  const group = createAvatar('#1a237e', '#f5cba7', 0x3c1a08, true);
  group.scale.set(2.8, 2.8, 2.8);
  // y=-0.88 brings shoe-bottom (local≈0.315) to floor level after ×2.8 scale
  group.position.set(0, -0.88, -12.0);
  group.rotation.y = Math.PI; // face students
  scene.add(group);
  teacherAvatarGroup = group;
  avatarGroups['__teacher__'] = group;
}

// =============================================
//  AVATAR CREATION
// =============================================
function createAvatar(shirtHex, skinHex, hairHex, isTeacher) {
  const group = new THREE.Group();

  const skinColor = typeof skinHex === 'string' ? parseInt(skinHex.replace('#', ''), 16) : skinHex;
  const shirtColor = typeof shirtHex === 'string' ? parseInt(shirtHex.replace('#', ''), 16) : shirtHex;

  const skinMat  = new THREE.MeshPhongMaterial({ color: skinColor, shininess: 20 });
  const hairMat  = new THREE.MeshPhongMaterial({ color: hairHex });
  const shirtMat = new THREE.MeshPhongMaterial({ color: shirtColor });
  const pantsMat = new THREE.MeshPhongMaterial({ color: isTeacher ? 0x263238 : 0x37474f });
  const shoeMat  = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });

  // Head
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), skinMat);
  head.position.y = 1.72;
  head.castShadow = true;

  // Hair
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 8), hairMat);
  hair.position.y = 1.82;
  hair.scale.set(1, 0.6, 1);

  // Eyes
  const eyeMat = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });
  const eyeGeo = new THREE.SphereGeometry(0.03, 6, 6);
  const leftEye = new THREE.Mesh(eyeGeo, eyeMat);
  leftEye.position.set(-0.065, 1.73, -0.15);
  const rightEye = new THREE.Mesh(eyeGeo, eyeMat);
  rightEye.position.set(0.065, 1.73, -0.15);

  // Torso
  const torso = makeMesh([0.38, 0.5, 0.22], shirtMat, [0, 1.3, 0]);

  // Collar (teacher's shirt)
  if (isTeacher) {
    const collar = makeMesh([0.12, 0.14, 0.22], new THREE.MeshPhongMaterial({ color: 0xffffff }), [0, 1.42, 0]);
    group.add(collar);
  }

  // Upper arms
  const armGeo = new THREE.BoxGeometry(0.1, 0.35, 0.1);
  const lArm = new THREE.Mesh(armGeo, shirtMat);
  lArm.position.set(-0.25, 1.32, 0);
  const rArm = new THREE.Mesh(armGeo, shirtMat);
  rArm.position.set(0.25, 1.32, 0);

  // Lower arms
  const lForearm = makeMesh([0.09, 0.3, 0.09], skinMat, [-0.25, 1.02, 0]);
  const rForearm = makeMesh([0.09, 0.3, 0.09], skinMat, [0.25, 1.02, 0]);

  // Hands
  const lHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), skinMat);
  lHand.position.set(-0.25, 0.85, 0);
  const rHand = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), skinMat);
  rHand.position.set(0.25, 0.85, 0);

  // Upper legs
  const legMat2 = pantsMat;
  const lThigh = makeMesh([0.16, 0.38, 0.15], legMat2, [-0.1, 0.93, 0]);
  const rThigh = makeMesh([0.16, 0.38, 0.15], legMat2, [0.1, 0.93, 0]);

  // Lower legs
  const lShank = makeMesh([0.13, 0.36, 0.13], legMat2, [-0.1, 0.57, 0]);
  const rShank = makeMesh([0.13, 0.36, 0.13], legMat2, [0.1, 0.57, 0]);

  // Shoes
  const lShoe = makeMesh([0.14, 0.09, 0.22], shoeMat, [-0.1, 0.36, -0.04]);
  const rShoe = makeMesh([0.14, 0.09, 0.22], shoeMat, [0.1, 0.36, -0.04]);

  group.add(head, hair, leftEye, rightEye, torso, lArm, rArm, lForearm, rForearm, lHand, rHand, lThigh, rThigh, lShank, rShank, lShoe, rShoe);

  // Store raise-arm reference
  group.userData.rArm = rArm;
  group.userData.rForearm = rForearm;
  group.userData.rHand = rHand;
  group.userData.handRaised = false;

  [head, hair, torso, lArm, rArm, lForearm, rForearm, lThigh, rThigh, lShank, rShank, lShoe, rShoe].forEach(m => {
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = false; }
  });

  return group;
}

function createSeatedAvatar(shirtHex, skinHex, hairHex) {
  // Built from scratch — not a modified standing avatar.
  // Group origin = floor (y=0). Chair seat top is at y=0.49.
  const group = new THREE.Group();

  const skinColor  = typeof skinHex  === 'string' ? parseInt(skinHex.replace('#',''),16)  : skinHex;
  const shirtColor = typeof shirtHex === 'string' ? parseInt(shirtHex.replace('#',''),16) : shirtHex;

  const skinMat  = new THREE.MeshPhongMaterial({ color: skinColor,  shininess: 20 });
  const hairMat  = new THREE.MeshPhongMaterial({ color: hairHex });
  const shirtMat = new THREE.MeshPhongMaterial({ color: shirtColor });
  const pantsMat = new THREE.MeshPhongMaterial({ color: 0x37474f });
  const shoeMat  = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });
  const eyeMat   = new THREE.MeshPhongMaterial({ color: 0x1a1a1a });

  const seatY = 0.50; // pelvis height (just above chair seat)

  // Head (seated eye-level ~1.2m)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), skinMat);
  head.position.set(0, 1.18, 0);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.185, 14, 8), hairMat);
  hair.position.set(0, 1.28, 0); hair.scale.set(1, 0.55, 1);

  // Eyes face –z (toward board)
  const eyeGeo = new THREE.SphereGeometry(0.028, 6, 6);
  const leftEye  = new THREE.Mesh(eyeGeo, eyeMat); leftEye.position.set(-0.065, 1.19, -0.15);
  const rightEye = new THREE.Mesh(eyeGeo, eyeMat); rightEye.position.set(0.065,  1.19, -0.15);

  // Torso (upright)
  const torso = makeMesh([0.36, 0.46, 0.20], shirtMat, [0, seatY + 0.23, 0]);

  // Upper arms
  const lArm = makeMesh([0.10, 0.30, 0.10], shirtMat, [-0.24, seatY + 0.25, 0]);
  const rArm = makeMesh([0.10, 0.30, 0.10], shirtMat, [ 0.24, seatY + 0.25, 0]);

  // Forearms rest forward on desk (–z)
  const lForearm = makeMesh([0.09, 0.10, 0.26], skinMat, [-0.22, seatY + 0.07, -0.14]);
  const rForearm = makeMesh([0.09, 0.10, 0.26], skinMat, [ 0.22, seatY + 0.07, -0.14]);

  // Hands
  const lHand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), skinMat);
  lHand.position.set(-0.20, seatY + 0.06, -0.27);
  const rHand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), skinMat);
  rHand.position.set( 0.20, seatY + 0.06, -0.27);

  // Thighs — horizontal in –z (toward board), resting on seat
  const thighLen = 0.38;
  const thighY   = seatY - 0.04; // 0.46
  const lThigh = makeMesh([0.155, 0.12, thighLen], pantsMat, [-0.10, thighY, -thighLen / 2]);
  const rThigh = makeMesh([0.155, 0.12, thighLen], pantsMat, [ 0.10, thighY, -thighLen / 2]);

  // Shins — hang straight DOWN at local z=+0.12 (visible from behind)
  const shinLen = 0.36;
  const shinY   = thighY - shinLen / 2; // center of shin
  const lShank = makeMesh([0.12, shinLen, 0.12], pantsMat, [-0.10, shinY, 0.12]);
  const rShank = makeMesh([0.12, shinLen, 0.12], pantsMat, [ 0.10, shinY, 0.12]);

  // Shoes — at base of shins, pointing slightly toward board
  const footY = thighY - shinLen + 0.04;
  const lShoe = makeMesh([0.14, 0.09, 0.22], shoeMat, [-0.10, footY, 0.06]);
  const rShoe = makeMesh([0.14, 0.09, 0.22], shoeMat, [ 0.10, footY, 0.06]);

  group.add(head, hair, leftEye, rightEye, torso,
            lArm, rArm, lForearm, rForearm, lHand, rHand,
            lThigh, rThigh, lShank, rShank, lShoe, rShoe);

  [head, hair, torso, lArm, rArm, lForearm, rForearm,
   lThigh, rThigh, lShank, rShank, lShoe, rShoe].forEach(m => {
    if (m.isMesh) m.castShadow = true;
  });

  group.userData.rArm = rArm;
  group.userData.rForearm = rForearm;
  group.userData.rHand = rHand;
  group.userData.handRaised = false;
  return group;
}

// =============================================
//  AVATAR ANIMATION
// =============================================
const shirtColors = [0xe53935, 0x1e88e5, 0x43a047, 0xfb8c00, 0x8e24aa, 0x00acc1, 0xf4511e, 0x6d4c41];
const skinColors  = [0xf5cba7, 0xd4a56a, 0x8d5524, 0xfce0c0, 0xc68642];
const hairColors  = [0x1a1a1a, 0x8B4513, 0xffd700, 0xcc6633, 0x4a4a4a];

function getOrCreateStudentAvatar(id, name, seat) {
  if (avatarGroups[id]) return avatarGroups[id];

  const shirtColor = shirtColors[seat % shirtColors.length];
  const skinColor  = skinColors[seat % skinColors.length];
  const hairColor  = hairColors[seat % hairColors.length];

  const group = createSeatedAvatar(shirtColor, skinColor, hairColor);

  const s = SEATS[seat];
  if (s) {
    group.scale.set(2.1, 2.1, 2.1);
    // y=-0.20 brings shoe-bottom (local≈0.095) to floor level after ×2.1 scale
    group.position.set(s.x, -0.20, s.z + 1.0);
    group.rotation.y = 0; // face –z (toward board/teacher)
  }

  // Name label on chair back (scale compensates for 2.1× group scale)
  const label = makeTextSprite(name, 0.35);
  label.position.set(0, 0.71, 0.17);
  group.add(label);

  scene.add(group);
  avatarGroups[id] = group;
  return group;
}

function animateAvatars() {
  const t = Date.now() * 0.001;

  // Animate teacher (subtle side sway while teaching)
  if (teacherAvatarGroup && teacherAvatarGroup.visible) {
    teacherAvatarGroup.position.x = Math.sin(t * 0.35) * 0.4;
  }

  // Animate raised hands
  Object.entries(avatarGroups).forEach(([id, group]) => {
    if (!group.userData) return;
    const rArm = group.userData.rArm;
    if (!rArm) return;
    if (group.userData.handRaised) {
      rArm.rotation.z = -Math.PI * 0.85 - Math.sin(t * 3) * 0.08;
      rArm.position.y = 1.5;
    } else {
      rArm.rotation.z = 0;
      rArm.position.y = 1.32;
    }
  });
}

// =============================================
//  TEXT SPRITE (name labels)
// =============================================
function makeTextSprite(text, scale = 1) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');

  // Background pill
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  roundRect(ctx, 6, 6, 500, 116, 18);
  ctx.fill();

  // White outline for contrast
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 2;
  roundRect(ctx, 6, 6, 500, 116, 18);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 56px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);

  const texture = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(scale * 2.4, scale * 0.6, 1);
  return sprite;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// =============================================
//  CLASSROOM STATE UPDATE
// =============================================
function updateClassroomState(state) {
  // Sync font size from server state
  if (state.fontSizeMode && FONT_SIZES[state.fontSizeMode]) {
    boardFontSize = FONT_SIZES[state.fontSizeMode];
    ['small', 'medium', 'large'].forEach(m => {
      const btn = document.getElementById(`size-${m}`);
      if (btn) btn.classList.toggle('size-active', m === state.fontSizeMode);
    });
  }

  // Update board
  drawBoard(state.boardLetters, state.currentHighlight);

  // Update teacher avatar visibility / name
  if (teacherAvatarGroup) {
    if (state.teacher) {
      teacherAvatarGroup.visible = true;
      const existing = teacherAvatarGroup.children.find(c => c.isSprite);
      if (!existing) {
        // scale=0.4 cancels most of the 2.8× group scale so world label stays readable
        const label = makeTextSprite(state.teacher.name, 0.4);
        label.position.set(0, 1.9, 0);
        teacherAvatarGroup.add(label);
      }
    }
  }

  // Update student avatars
  const currentIds = new Set(state.students.map(s => s.id));

  // Remove disconnected
  Object.keys(avatarGroups).forEach(id => {
    if (id === '__teacher__') return;
    if (!currentIds.has(id)) {
      scene.remove(avatarGroups[id]);
      delete avatarGroups[id];
    }
  });

  // Add/update students
  state.students.forEach(student => {
    const group = getOrCreateStudentAvatar(student.id, student.name, student.seat);
    group.userData.handRaised = student.handRaised;
  });

  // Update UI
  updateStudentsList(state);
  updateBoardUI(state);

  // Sync WebRTC peer connections (teacher only)
  syncPeerConnections(state);
}

// =============================================
//  UI UPDATES
// =============================================
function updateStudentsList(state) {
  const container = document.getElementById('students-items');
  if (!container) return;

  const teacherLine = state.teacher
    ? `<div class="student-item"><div class="student-dot" style="background:#ffa000"></div>👩‍🏫 ${state.teacher.name} (Teacher)</div>`
    : '';

  const studentLines = state.students.map(s =>
    `<div class="student-item">
      <div class="student-dot"></div>
      ${s.name}
      ${s.handRaised ? '<span class="hand-icon">✋</span>' : ''}
    </div>`
  ).join('');

  container.innerHTML = teacherLine + (studentLines || '<div style="color:#555;font-size:0.8rem;">No students yet</div>');
}

function updateBoardUI(state) {
  if (myRole !== 'teacher') {
    // Update student board display
    const display = document.getElementById('board-display');
    if (!display) return;
    if (state.boardLetters.length === 0) {
      display.innerHTML = '<span style="color:#555;font-size:0.85rem;">Waiting for teacher to write...</span>';
      return;
    }
    display.innerHTML = state.boardLetters.map((l, i) =>
      `<div class="board-letter${i === state.currentHighlight ? ' highlighted' : ''}">${l}</div>`
    ).join('');
  }
}

// =============================================
//  TEACHER ACTIONS
// =============================================
let shiftMode = false; // false = uppercase+numbers, true = lowercase+symbols

function buildKeyboard() {
  const grid = document.getElementById('alphabet-grid');
  grid.innerHTML = '';

  const shiftKey  = { label: shiftMode ? '⇧ ABC' : '⇧ abc', char: '⇧', cls: 'key-shift' + (shiftMode ? ' key-shift-on' : '') };
  const spaceKey  = { label: 'SPACE', char: ' ', cls: 'key-wide' };
  const enterKey  = { label: '↵ Enter', char: '\n', cls: 'key-wide key-enter' };
  const delKey    = { label: '⌫',    char: '⌫', cls: 'key-del'  };
  const bottomRow = [shiftKey, spaceKey, '.', ',', '?', '!', "'", '"', '-', '+', '=', enterKey, delKey];

  const rows = shiftMode ? [
    // ── Lowercase + extra symbols ──
    ['q','w','e','r','t','y','u','i','o','p'],
    ['a','s','d','f','g','h','j','k','l'],
    ['z','x','c','v','b','n','m'],
    ['*',';',':','@','#','$','%','&','(',')','{','}','/','|','<','>'],
    bottomRow
  ] : [
    // ── Uppercase + numbers ──
    ['1','2','3','4','5','6','7','8','9','0'],
    ['Q','W','E','R','T','Y','U','I','O','P'],
    ['A','S','D','F','G','H','J','K','L'],
    ['Z','X','C','V','B','N','M'],
    bottomRow
  ];

  rows.forEach((row, ri) => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'keyboard-row';
    // symbol row gets narrower keys
    const isSymRow = shiftMode && ri === 3;
    row.forEach(k => {
      const isObj  = typeof k === 'object';
      const char   = isObj ? k.char  : k;
      const label  = isObj ? k.label : k;
      const btn    = document.createElement('button');
      btn.className = 'key-btn'
        + (isSymRow ? ' key-sym' : '')
        + (isObj && k.cls ? ' ' + k.cls : '');
      btn.textContent = label;
      if      (char === '⌫') btn.onclick = boardBackspace;
      else if (char === '⇧') btn.onclick = toggleShift;
      else if (char === '\n') btn.onclick = () => writeLetterOnBoard('\n');
      else { btn.dataset.char = char; btn.onclick = () => writeLetterOnBoard(char); }
      rowDiv.appendChild(btn);
    });
    grid.appendChild(rowDiv);
  });
}

function toggleShift() {
  shiftMode = !shiftMode;
  buildKeyboard();
}

function boardBackspace() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  boardScrollLines = 0; // jump back to latest when editing
  ws.send(JSON.stringify({ type: 'board_backspace' }));
  showToast('⌫ Deleted last character');
}

function writeLetterOnBoard(letter) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  boardScrollLines = 0; // jump back to latest when typing
  ws.send(JSON.stringify({ type: 'board_add', letter }));
  showToast(`✏ Writing "${letter}" on board`);

  // Teacher turns to face board, writes, then turns back to face students
  if (teacherAvatarGroup) {
    teacherAvatarGroup.rotation.y = 0;        // turn to face board
    setTimeout(() => {
      if (teacherAvatarGroup) teacherAvatarGroup.rotation.y = Math.PI; // turn back to students
    }, 1800);
  }
}

function clearBoard() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  boardScrollLines = 0;
  ws.send(JSON.stringify({ type: 'board_clear' }));
  showToast('Board cleared');
}

function setBoardFontSize(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'board_fontsize', mode }));
}

function scrollBoardUp() {
  boardScrollLines++;
  drawBoard(classroomState.boardLetters, classroomState.currentHighlight);
}

function scrollBoardDown() {
  boardScrollLines = Math.max(0, boardScrollLines - 1);
  drawBoard(classroomState.boardLetters, classroomState.currentHighlight);
}

// =============================================
//  PANEL TOGGLES
// =============================================
function toggleTeacherPanel() {
  const body  = document.getElementById('teacher-panel-body');
  const arrow = document.getElementById('teacher-panel-arrow');
  const open  = body.style.display === 'block';
  body.style.display  = open ? 'none' : 'block';
  arrow.textContent   = open ? '▲' : '▼';
}

let chatCollapsed = false;
function toggleChatPanel() {
  const panel = document.getElementById('chat-panel');
  const arrow = document.getElementById('chat-panel-arrow');
  chatCollapsed = !chatCollapsed;
  panel.classList.toggle('collapsed', chatCollapsed);
  arrow.textContent = chatCollapsed ? '◀' : '▶';
  const sideWidth = chatCollapsed ? 36 : 340;
  const sp = document.getElementById('student-panel');
  if (sp) sp.style.right = sideWidth + 'px';
}

// =============================================
//  STUDENT ACTIONS
// =============================================
function toggleStudentBoard() {
  const body  = document.getElementById('student-board-body');
  const arrow = document.getElementById('student-board-arrow');
  const open  = body.style.display === 'block';
  body.style.display = open ? 'none' : 'block';
  arrow.textContent  = open ? '▲' : '▼';
}

function toggleHand() {
  handRaised = !handRaised;
  const btn = document.getElementById('hand-btn');
  btn.textContent = handRaised ? '✋ Lower Hand' : '✋ Raise Hand';
  btn.classList.toggle('raised', handRaised);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'raise_hand', raised: handRaised }));
  }
  showToast(handRaised ? 'Hand raised!' : 'Hand lowered');
}

// =============================================
//  CHAT
// =============================================
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'chat', message: msg }));
  input.value = '';
}

function appendChat(msg) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  const cls = msg.system ? 'system-msg' : msg.role === 'teacher' ? 'teacher-msg' : '';
  div.className = `chat-msg ${cls}`;
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-name">${msg.system ? '🔔' : msg.role === 'teacher' ? '👩‍🏫' : '🧑‍🎓'} ${msg.name}</span>
      <span class="msg-time">${msg.time}</span>
    </div>
    <div class="msg-text">${escHtml(msg.message)}</div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// =============================================
//  TOAST NOTIFICATION
// =============================================
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// =============================================
//  WEBRTC AUDIO
// =============================================
async function initAudio() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Teacher unmuted by default so students hear them; students start muted
    setMicState(myRole === 'student');
    document.getElementById('mic-btn').style.display = 'inline-block';
    showToast(myRole === 'student' ? '🎤 Mic ready — click Unmute to speak' : '🎤 Mic active — students can hear you');
    // If teacher already has students in state (joined late), connect now
    if (myRole === 'teacher' && classroomState.students.length) {
      syncPeerConnections(classroomState);
    }
  } catch (err) {
    console.warn('Mic error:', err);
    showToast('⚠️ Mic access denied — voice chat disabled');
  }
}

function setMicState(muted) {
  micMuted = muted;
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  const btn = document.getElementById('mic-btn');
  if (!btn) return;
  btn.textContent = muted ? '🔇 Unmute' : '🎤 Mute';
  btn.classList.toggle('mic-muted', muted);
}

function toggleMic() {
  setMicState(!micMuted);
}

async function createPeerConn(peerId, initiator) {
  if (peerConns[peerId]) return;
  const pc = new RTCPeerConnection(RTC_CFG);
  peerConns[peerId] = pc;
  iceBuf[peerId] = [];

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    let audio = peerAudioEls[peerId];
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      document.body.appendChild(audio);
      peerAudioEls[peerId] = audio;
    }
    audio.srcObject = e.streams[0];
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendRtcSignal(peerId, { type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeerConn(peerId);
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendRtcSignal(peerId, { type: 'offer', sdp: pc.localDescription });
  }
}

function sendRtcSignal(toId, signal) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'rtc_signal', to: toId, signal }));
  }
}

async function handleRtcSignal(fromId, signal) {
  try {
    if (signal.type === 'offer') {
      if (peerConns[fromId]) return;
      await createPeerConn(fromId, false);
      const pc = peerConns[fromId];
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      for (const c of (iceBuf[fromId] || [])) await pc.addIceCandidate(c);
      iceBuf[fromId] = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendRtcSignal(fromId, { type: 'answer', sdp: pc.localDescription });

    } else if (signal.type === 'answer') {
      const pc = peerConns[fromId];
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        for (const c of (iceBuf[fromId] || [])) await pc.addIceCandidate(c);
        iceBuf[fromId] = [];
      }

    } else if (signal.type === 'ice') {
      const pc = peerConns[fromId];
      const cand = new RTCIceCandidate(signal.candidate);
      if (pc && pc.remoteDescription) {
        await pc.addIceCandidate(cand);
      } else {
        (iceBuf[fromId] = iceBuf[fromId] || []).push(cand);
      }
    }
  } catch (e) {
    console.warn('RTC signal error:', e);
  }
}

function closePeerConn(peerId) {
  const pc = peerConns[peerId];
  if (pc) { try { pc.close(); } catch(e) {} delete peerConns[peerId]; }
  const audio = peerAudioEls[peerId];
  if (audio) { audio.srcObject = null; audio.remove(); delete peerAudioEls[peerId]; }
  delete iceBuf[peerId];
}

// Teacher initiates and manages peer connections for all students
function syncPeerConnections(state) {
  if (myRole !== 'teacher' || !myId || !localStream) return;
  const liveIds = new Set(state.students.map(s => s.id));
  state.students.forEach(s => { if (!peerConns[s.id]) createPeerConn(s.id, true); });
  Object.keys(peerConns).forEach(pid => { if (!liveIds.has(pid)) closePeerConn(pid); });
}

// =============================================
//  UTILITY
// =============================================
function makeMesh(size, mat, pos) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
  mesh.position.set(...pos);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
