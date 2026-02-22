const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const MC = 52, MR = 32;
const RAW = [
  "0000000000000110011000000000000001100000000000000000",
  "0000000000000110011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000011111100111",
  "0011000000000110011000000000000001100000011111100111",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000110000000000000000000100111001111111100",
  "0011000000000110000000000000000000000111001111111100",
  "0011000000000110000000000000000000100110000000001100",
  "0011000000000110011000000000000001100110000000001100",
  "0011111100000110011000000000000001100110000000001100",
  "0001111100000110011000000000000001100110000000000000",
  "0000001100000110011000000000000001100110000000000000",
  "0000001110011110011111111001111111100111111111111100",
  "0000001110011110011111111001111111100111111111111100",
  "0000000000000000011000000000000001100000000000000000",
  "0000000000000000000000000000000000000000000000000000",
  "0011100000000000000000000000000000000000000000000000",
  "0011100111111110000000000000000001100111111111111100",
  "0011100111111110000000000000000001100111111111111100",
  "0000000110000110000000000000000001100000000000001100",
  "0000000110000110011111111001111111100000000000001100",
  "0011111110011110011111111000111111100000000000001100",
  "0011111110011110011000000000000001100000000000001100",
  "0011000000000000011000000000000001100000000000001100",
  "0011000000000000011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000000000000000",
  "0011000000000110011000000000000001100000000000001100",
  "0011111111001110011111111001111111100000000000001100",
  "0011111111001110011111111001111111100000000000001100",
  "0000000000000110000000000000000001100000000000001100",
  "0000000000000110000000000000000001100000000000001100",
];
const MAP = [];
for (let r = 0; r < MR; r++) { MAP[r] = []; for (let c = 0; c < MC; c++) MAP[r][c] = +RAW[r][c] || 0; }
for (let c = 0; c < MC; c++) { MAP[0][c] = 1; MAP[MR-1][c] = 1; }
for (let r = 0; r < MR; r++) { MAP[r][0] = 1; MAP[r][MC-1] = 1; }

const CELL = 0.62;
const OPEN = [];
for (let r = 2; r < MR-2; r++) for (let c = 2; c < MC-2; c++) if (!MAP[r][c]) OPEN.push({ r, c });

function randOpen() { const o = OPEN[Math.floor(Math.random()*OPEN.length)]; return { x:(o.c+.5)*CELL, z:(o.r+.5)*CELL }; }

function solid(x, z) { const c=Math.floor(x/CELL),r=Math.floor(z/CELL); return r<0||r>=MR||c<0||c>=MC||!!MAP[r][c]; }
const PR = 0.25*CELL;
function canWalk(x,z) { return !solid(x-PR,z-PR)&&!solid(x+PR,z-PR)&&!solid(x-PR,z+PR)&&!solid(x+PR,z+PR); }
function applyMove(p, dx, dz) {
  const nx=p.x+dx, nz=p.z+dz;
  if (canWalk(nx,nz)) { p.x=nx; p.z=nz; }
  else if (canWalk(nx,p.z)) { p.x=nx; }
  else if (canWalk(p.x,nz)) { p.z=nz; }
}

function ghostVisCheck(hunter, ghostP) {
  if (!hunter.flashOn || hunter.battery<=0 || !ghostP) return false;
  const dx=ghostP.x-hunter.x, dz=ghostP.z-hunter.z;
  const d=Math.hypot(dx,dz);
  if (d<0.01||d>5.5*CELL) return false;
  const cos=(dx*Math.sin(hunter.yaw)+dz*Math.cos(hunter.yaw))/d;
  if (cos<0.60) return false;
  const steps=Math.ceil(d/0.12)+1;
  for (let i=1;i<steps;i++) { const t=i/steps; if (solid(hunter.x+dx*t, hunter.z+dz*t)) return false; }
  return true;
}

const rooms = new Map();
function genCode() {
  const ch='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code;
  do { code=Array.from({length:6},()=>ch[Math.floor(Math.random()*ch.length)]).join(''); } while(rooms.has(code));
  return code;
}

class Room {
  constructor(code) {
    this.code=code; this.players=new Map(); this.phase='lobby';
    this.ghostHp=100; this.ghostStunT=0;
    this.ghostLitVis=false; this.ghostLitMM=false;
    this.litAmt=0; this.litTimer=30+Math.random()*15;
    this.batTimer=6; this.batteries=[]; this.tick=null;
  }

  addPlayer(id, name) {
    this.players.set(id, {
      id, name, role:null, x:0, y:0, z:0,
      yaw:0, pitch:0, battery:1, flashOn:true,
      lives:3, alive:true, ready:false, atkCd:0,
      color:`hsl(${Math.floor(Math.random()*300)+30},80%,60%)`
    });
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.players.size===0) this.destroy();
  }

  lobbyState() {
    return Array.from(this.players.values()).map(p=>({id:p.id,name:p.name,ready:p.ready,color:p.color}));
  }

  startGame() {
    this.phase='game';
    this.ghostHp=100; this.ghostStunT=0; this.litAmt=0;
    this.ghostLitVis=false; this.ghostLitMM=false;
    this.batteries=[]; this.batTimer=6;
    this.litTimer=30+Math.random()*15;

    // Shuffle players, assign roles
    const pArr=Array.from(this.players.values());
    for (let i=pArr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pArr[i],pArr[j]]=[pArr[j],pArr[i]]; }
    pArr[0].role='ghost';
    for (let i=1;i<pArr.length;i++) pArr[i].role='hunter';

    // Spawn ghost
    const gsp=randOpen();
    pArr[0].x=gsp.x; pArr[0].z=gsp.z; pArr[0].y=0.33*CELL;
    pArr[0].attackCooldown=0;

    // Spawn hunters far from ghost
    for (let i=1;i<pArr.length;i++) {
      let sp, tries=0;
      do { sp=randOpen(); tries++; } while (tries<60 && Math.hypot(sp.x-gsp.x,sp.z-gsp.z)<5*CELL);
      pArr[i].x=sp.x; pArr[i].z=sp.z; pArr[i].y=0.52*CELL;
      const hunterCount=pArr.length-1;
      const livesMap={1:3,2:2,3:1};
      pArr[i].battery=1; pArr[i].flashOn=true; 
      pArr[i].lives=livesMap[hunterCount]||1;
      pArr[i].maxLives=livesMap[hunterCount]||1;
      pArr[i].downed=false; pArr[i].downT=0;
      pArr[i].alive=true;
    }

    for (let i=0;i<2;i++) this.spawnBat();

    let last=Date.now();
    this.tick=setInterval(()=>{ const now=Date.now(); const dt=Math.min((now-last)/1000,.05); last=now; this.update(dt); },50);
  }

  spawnBat() {
    const p=randOpen();
    this.batteries.push({x:p.x,z:p.z,y:0.55*CELL,id:Math.random().toString(36).slice(2),life:20});
  }

  update(dt) {
    if (this.phase!=='game') return;
    const pArr=Array.from(this.players.values());
    const ghostP=pArr.find(p=>p.role==='ghost');
    const hunters=pArr.filter(p=>p.role==='hunter');

    if (this.ghostStunT>0) this.ghostStunT-=dt;

    // Lightning
    this.litTimer-=dt;
    if (this.litTimer<=0) {
      this.litAmt=1.0; this.ghostLitVis=true; this.ghostLitMM=true;
      io.to(this.code).emit('lightning:strike');
      setTimeout(()=>{ this.ghostLitVis=false; },750);
      setTimeout(()=>{ this.ghostLitMM=false; },2300);
      this.litTimer=35+Math.random()*20;
    }
    this.litAmt=Math.max(0,this.litAmt-dt*3);

    // Hunter battery drain (server authoritative — no randomness)
    for (const h of hunters) {
      if (!h.alive) continue;
      if (h.flashOn) h.battery=Math.max(0,h.battery-dt*0.055);
      if (h.battery<=0) { h.battery=0; h.flashOn=false; }
      if (h.atkCd>0) h.atkCd-=dt;
    }

    // Battery spawn & pickup — only spawn if any hunter is under 50%
    this.batTimer-=dt;
    const needsBat=hunters.some(h=>h.alive&&!h.downed&&h.battery<0.5);
    if (this.batTimer<=0&&this.batteries.length<3&&needsBat) { this.spawnBat(); this.batTimer=10+Math.random()*8; }
    this.batteries=this.batteries.filter(b=>{
      b.life-=dt; if(b.life<=0) return false;
      for (const h of hunters) {
        if (!h.alive) continue;
        if (Math.hypot(h.x-b.x,h.z-b.z)<0.7*CELL) { h.battery=Math.min(1,h.battery+0.6); io.to(h.id).emit('battery:pickup'); return false; }
      }
      return true;
    });

    // Ghost visibility from flashlights (recalculate each tick — no stale state)
    let ghostSeenThisTick=false;
    if (this.ghostStunT<=0&&ghostP) {
      for (const h of hunters) {
        if (!h.alive) continue;
        if (ghostVisCheck(h,ghostP)) {
          ghostSeenThisTick=true;
          if (h.flashOn&&h.battery>0) this.ghostHp=Math.max(0,this.ghostHp-22*dt);
        }
      }
    }

    // Ghost E-attack cooldown
    if (ghostP&&ghostP.attackCooldown>0) ghostP.attackCooldown-=dt;

    // Hunter revive check — any alive hunter shining flashlight on a downed ally can revive
    for (const h of hunters) {
      if (!h.alive||h.downed||!h.flashOn||h.battery<=0) continue;
      for (const target of hunters) {
        if (target.id===h.id||!target.downed) continue;
        const dx=target.x-h.x, dz=target.z-h.z;
        const d=Math.hypot(dx,dz);
        if (d>4.5*CELL) continue;
        const cos=(dx*Math.sin(h.yaw)+dz*Math.cos(h.yaw))/Math.max(d,0.01);
        if (cos<0.55) continue;
        // Revive! Costs reviver 50% battery (needs at least 50%)
        if (h.battery<0.5) continue;
        h.battery=Math.max(0,h.battery-0.5);
        target.downed=false; target.lives=1; target.atkCd=0;
        io.to(this.code).emit('hunter:revived',{hunterId:target.id,name:target.name});
      }
    }

    // Downed timer
    for (const h of hunters) {
      if (!h.downed) continue;
      h.downT=(h.downT||0)+dt;
      const aliveReviviers=hunters.filter(q=>q.id!==h.id&&q.alive&&!q.downed);
      if (aliveReviviers.length===0&&h.downT>8) {
        // No one to revive (1v1 or all others down) -> eliminate
        h.downed=false; h.alive=false;
        io.to(this.code).emit('hunter:eliminated',{hunterId:h.id,name:h.name});
      }
    }

    if (this.ghostHp<=0) { this.endGame('hunters'); return; }
    if (hunters.length>0&&hunters.every(h=>!h.alive||h.downed)) { this.endGame('ghost'); return; }

    this.ghostInLight=ghostSeenThisTick;
    this.broadcast(ghostSeenThisTick,ghostInFlashlight);
  }

  broadcast(ghostSeenThisTick,ghostInFlashlight=false) {
    const pArr=Array.from(this.players.values());
    const ghostP=pArr.find(p=>p.role==='ghost');

    // Single player list for all receivers
    const playerList=pArr.map(p=>({
      id:p.id, role:p.role, name:p.name, color:p.color,
      x:p.x, y:p.y, z:p.z, yaw:p.yaw,
      battery:p.battery, flashOn:p.flashOn,
      lives:p.lives, alive:p.alive, downed:!!p.downed,
    }));

    for (const recv of pArr) {
      const ghostDist=(!recv.role||recv.role==='hunter')&&ghostP
        ? Math.hypot(recv.x-ghostP.x, recv.z-ghostP.z) : 9999;

      io.to(recv.id).emit('game:state',{
        players: playerList,
        ghostVisible: this.ghostLitVis||ghostSeenThisTick,
        ghostMinimap: this.ghostLitMM,
        ghostHp: this.ghostHp,
        ghostSlowed: !!ghostInFlashlight,
        litAmt: this.litAmt,
        batteries: this.batteries,
        ghostDist,
        ghostInLight: recv.role==='ghost' ? ghostSeenThisTick : false,
        myId: recv.id,
      });
    }
  }

  endGame(winner) {
    if (this.phase==='ended') return;
    this.phase='ended';
    if (this.tick) { clearInterval(this.tick); this.tick=null; }
    io.to(this.code).emit('game:end',{winner});
    setTimeout(()=>this.destroy(),30000);
  }

  destroy() {
    if (this.tick) { clearInterval(this.tick); this.tick=null; }
    rooms.delete(this.code);
  }
}

io.on('connection',(socket)=>{
  let room=null;

  socket.on('room:create',({playerName},cb)=>{
    const code=genCode(), r=new Room(code);
    rooms.set(code,r); r.addPlayer(socket.id,playerName||'Player');
    socket.join(code); room=r;
    cb({ok:true,code});
    io.to(code).emit('lobby:state',{players:r.lobbyState()});
  });

  socket.on('room:join',({code,playerName},cb)=>{
    const c=(code||'').toUpperCase().trim(), r=rooms.get(c);
    if (!r) return cb({ok:false,error:'Room not found'});
    if (r.phase!=='lobby') return cb({ok:false,error:'Game already started'});
    if (r.players.size>=4) return cb({ok:false,error:'Room full (max 4)'});
    r.addPlayer(socket.id,playerName||'Player');
    socket.join(c); room=r;
    cb({ok:true,code:c});
    io.to(c).emit('lobby:state',{players:r.lobbyState()});
  });

  socket.on('room:ready',({ready})=>{
    if (!room) return;
    const p=room.players.get(socket.id);
    if (p) p.ready=!!ready;
    io.to(room.code).emit('lobby:state',{players:room.lobbyState()});
    const pArr=Array.from(room.players.values());
    if (pArr.length>=2&&pArr.every(p=>p.ready)&&room.phase==='lobby') {
      room.startGame();
      // Include spawn positions in game:start so client places player correctly
      io.to(room.code).emit('game:start',{
        players:Array.from(room.players.values()).map(p=>({
          id:p.id, role:p.role, color:p.color,
          name:p.name, lives:p.lives,
          x:p.x, y:p.y, z:p.z,   // spawn positions
        }))
      });
    }
  });

  socket.on('input',(input)=>{
    if (!room||room.phase!=='game') return;
    const p=room.players.get(socket.id);
    if (!p||!p.alive) return;
    const {x,z,yaw,pitch,flashOn,attack}=input;
    // Trust client position (client handles collision locally)
    if (typeof x==='number'&&isFinite(x)&&x>0&&x<MC*CELL) p.x=x;
    if (typeof z==='number'&&isFinite(z)&&z>0&&z<MR*CELL) p.z=z;
    if (typeof yaw==='number'&&isFinite(yaw)) p.yaw=yaw;
    if (typeof pitch==='number'&&isFinite(pitch)) p.pitch=Math.max(-1.05,Math.min(1.05,pitch));
    if (p.role==='hunter'&&typeof flashOn==='boolean') {
      p.flashOn=flashOn&&p.battery>0;
    }
    if (attack&&p.role==='hunter') {
      const gp=Array.from(room.players.values()).find(q=>q.role==='ghost');
      if (gp&&room.ghostStunT<=0&&ghostVisCheck(p,gp)) {
        room.ghostHp=Math.max(0,room.ghostHp-2);
        room.ghostStunT=1.5;
        io.to(room.code).emit('ghost:hit',{hp:room.ghostHp});
      }
    }
    // Ghost E-attack: down nearest hunter
    // Ghost dash (Space)
    if (input.ghostDash&&p.role==='ghost'&&(p.dashCooldown||0)<=0&&!room.ghostInLight) {
      p.dashActive=true; p.dashT=0; p.dashCooldown=4.0;
      // Pre-compute dash direction from current yaw
      p.dashDX=Math.sin(p.yaw)*2.2*CELL;
      p.dashDZ=Math.cos(p.yaw)*2.2*CELL;
      io.to(p.id).emit('ghost:dash',{cooldown:4.0});
    }
    if (p.dashCooldown>0) p.dashCooldown-=0.05; // per tick ~50ms
    if (p.dashActive) {
      p.dashT=(p.dashT||0)+0.05;
      const frac=Math.min(1,p.dashT/0.25);
      const dx=p.dashDX*(1-frac)*0.25;
      const dz=p.dashDZ*(1-frac)*0.25;
      applyMove(p,dx,dz);
      if (p.dashT>=0.25) p.dashActive=false;
    }
        if (input.ghostAttack&&p.role==='ghost'&&(p.attackCooldown||0)<=0&&!room.ghostInLight) {
      const hunters2=Array.from(room.players.values()).filter(q=>q.role==='hunter');
      for (const h of hunters2) {
        if (!h.alive||h.downed) continue;
        if (Math.hypot(h.x-p.x,h.z-p.z)<1.2*CELL) {
          h.lives=Math.max(0,h.lives-1);
          h.downT=0;
          if (h.lives<=0) {
            // Last life gone -> DOWNED (third person, wait for revive)
            h.downed=true; h.downT=0;
            const sp=randOpen();
            h._respawnX=sp.x; h._respawnZ=sp.z;
            io.to(room.code).emit('hunter:downed',{hunterId:h.id,name:h.name,lives:0,respawnX:sp.x,respawnZ:sp.z});
          } else {
            // Lives remain -> immediate respawn elsewhere, black flash on client
            let sp, tries=0;
            do { sp=randOpen(); tries++; } while(tries<40&&Math.hypot(sp.x-p.x,sp.z-p.z)<4*CELL);
            h.x=sp.x; h.z=sp.z;
            io.to(h.id).emit('hunter:respawn',{lives:h.lives,x:sp.x,z:sp.z});
            io.to(room.code).emit('hunter:hit',{hunterId:h.id,lives:h.lives,name:h.name});
          }
          p.attackCooldown=2.0;
          break;
        }
      }
    }
  });

  socket.on('disconnect',()=>{
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size>0) io.to(room.code).emit('lobby:state',{players:room.lobbyState()});
    room=null;
  });
});

const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Ghost Manor :${PORT}`));
