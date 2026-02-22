const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('coras');

const app = express();
app.use(cors());
app.get('/health', (_, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('/version', (_, res) => res.json({ version: 'v6', built: new Date().toISOString() }));
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

const REVIVE_TIME = 5.0; // seconds to revive a downed hunter
const REVIVE_RADIUS = 1.2 * CELL; // how close you need to be

class Room {
  constructor(code) {
    this.code=code; this.players=new Map(); this.phase='lobby';
    this.ghostHp=100; this.ghostStunT=0;
    this.ghostLitVis=false; this.ghostLitMM=false;
    this.litAmt=0; this.litTimer=30+Math.random()*15;
    this.batTimer=6; this.batteries=[]; this.tick=null;
    this.gameCount=0;
  }

  addPlayer(id, name) {
    this.players.set(id, {
      id, name, role:null, x:0, y:0, z:0,
      yaw:0, pitch:0, battery:1, flashOn:true,
      lives:3, alive:true, downed:false, reviveProgress:0,
      ready:false, atkCd:0, dashCd:0, killCd:0,
      color:`hsl(${Math.floor(Math.random()*300)+30},80%,60%)`
    });
  }

  resetForRematch() {
    this.phase='lobby';
    this.ghostHp=100; this.ghostStunT=0;
    this.ghostLitVis=false; this.ghostLitMM=false;
    this.litAmt=0; this.litTimer=30+Math.random()*15;
    this.batTimer=6; this.batteries=[];
    if (this.tick) { clearInterval(this.tick); this.tick=null; }
    this.gameCount++;
    for (const p of this.players.values()) {
      p.ready=false; p.role=null; p.alive=true; p.downed=false; p.reviveProgress=0;
      p.lives=3; p.battery=1; p.flashOn=true; p.atkCd=0; p.dashCd=0; p.killCd=0;
    }
    io.to(this.code).emit('lobby:state',{players:this.lobbyState()});
    io.to(this.code).emit('rematch:ready',{code:this.code});
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

    const pArr=Array.from(this.players.values());
    for (let i=pArr.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [pArr[i],pArr[j]]=[pArr[j],pArr[i]]; }
    pArr[0].role='ghost';
    for (let i=1;i<pArr.length;i++) pArr[i].role='hunter';

    const gsp=randOpen();
    pArr[0].x=gsp.x; pArr[0].z=gsp.z; pArr[0].y=0.33*CELL;
    pArr[0].dashCd=0; pArr[0].killCd=0;

    for (let i=1;i<pArr.length;i++) {
      let sp, tries=0;
      do { sp=randOpen(); tries++; } while (tries<60 && Math.hypot(sp.x-gsp.x,sp.z-gsp.z)<5*CELL);
      pArr[i].x=sp.x; pArr[i].z=sp.z; pArr[i].y=0.52*CELL;
      pArr[i].battery=1; pArr[i].flashOn=true; pArr[i].lives=3;
      pArr[i].alive=true; pArr[i].downed=false; pArr[i].reviveProgress=0;
    }

    for (let i=0;i<2;i++) this.spawnBat();

    let last=Date.now();
    let _tickN=0;
    this.tick=setInterval(()=>{ 
      const now=Date.now(); const dt=Math.min((now-last)/1000,.05); last=now; 
      _tickN++;
      if(_tickN===1||_tickN%100===0){
        const pArr2=Array.from(this.players.values());
        console.log(`[tick ${_tickN}] room=${this.code} players:${pArr2.map(p=>p.id.slice(-4)+':'+p.role+'@('+p.x.toFixed(2)+','+p.z.toFixed(2)+')').join(' ')}`);
      }
      this.update(dt); 
    },50);
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

    // Ghost cooldowns
    if (ghostP) {
      if (ghostP.dashCd>0) ghostP.dashCd=Math.max(0,ghostP.dashCd-dt);
      if (ghostP.killCd>0) ghostP.killCd=Math.max(0,ghostP.killCd-dt);
    }

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

    // Hunter battery drain — only active (not downed) hunters drain battery
    for (const h of hunters) {
      if (!h.alive || h.downed) continue;
      if (h.flashOn) h.battery=Math.max(0,h.battery-dt*0.013);
      if (h.battery<=0) { h.battery=0; h.flashOn=false; }
      if (h.atkCd>0) h.atkCd-=dt;
    }

    // ── REVIVE SYSTEM ──────────────────────────────────────────────
    // Reset revive progress for all downed hunters each tick, then accumulate
    const downedHunters=hunters.filter(h=>h.downed&&h.alive);
    const activeHunters=hunters.filter(h=>!h.downed&&h.alive);

    for (const downed of downedHunters) {
      let beingRevived=false;
      for (const active of activeHunters) {
        if (Math.hypot(active.x-downed.x, active.z-downed.z) < REVIVE_RADIUS) {
          beingRevived=true;
          break;
        }
      }
      if (beingRevived) {
        downed.reviveProgress=Math.min(REVIVE_TIME, downed.reviveProgress+dt);
        // Drain battery from the reviver (50% over 5s = 0.10/s drain while reviving)
        for (const active of activeHunters) {
          if (Math.hypot(active.x-downed.x, active.z-downed.z) < REVIVE_RADIUS) {
            active.battery=Math.max(0, active.battery - dt*0.10);
            if (active.battery<=0) active.flashOn=false;
          }
        }
        if (downed.reviveProgress>=REVIVE_TIME) {
          // Revived!
          downed.downed=false;
          downed.lives=1; // revived with 1 life
          downed.reviveProgress=0;
          io.to(downed.id).emit('hunter:revived');
          io.to(this.code).emit('hunter:revive_complete',{hunterId:downed.id});
        }
      } else {
        // Nobody nearby — revive progress drains back slowly
        downed.reviveProgress=Math.max(0, downed.reviveProgress-dt*0.5);
      }
    }

    // Battery spawn & pickup — only active hunters pick up batteries
    this.batTimer-=dt;
    if (this.batTimer<=0&&this.batteries.length<3) { this.spawnBat(); this.batTimer=10+Math.random()*8; }
    this.batteries=this.batteries.filter(b=>{
      b.life-=dt; if(b.life<=0) return false;
      for (const h of activeHunters) {
        if (Math.hypot(h.x-b.x,h.z-b.z)<0.7*CELL) { h.battery=Math.min(1,h.battery+0.25); io.to(h.id).emit('battery:pickup'); return false; }
      }
      return true;
    });

    // Ghost visibility — only active hunters can damage ghost with flashlight
    let ghostSeenThisTick=false;
    if (ghostP) {
      for (const h of activeHunters) {
        if (ghostVisCheck(h,ghostP)) {
          ghostSeenThisTick=true;
          if (h.flashOn&&h.battery>0) this.ghostHp=Math.max(0,this.ghostHp-5*dt);
          // Keep stun refreshed while ghost is in flashlight beam — ghost can't kill while lit
          this.ghostStunT=Math.max(this.ghostStunT, 0.12);
        }
      }
    }

    // Ghost touch attack on hunters
    // Ghost can down active hunters AND can finish off downed hunters permanently
    if (ghostP&&this.ghostStunT<=0&&ghostP.killCd<=0) {
      // Attack active hunters → downs them
      for (const h of activeHunters) {
        if (h.atkCd>0) continue;
        if (Math.hypot(h.x-ghostP.x,h.z-ghostP.z)<0.75*CELL) {
          h.lives=Math.max(0,h.lives-1);
          h.atkCd=2.5;
          ghostP.killCd=2.0;
          io.to(h.id).emit('hunter:hit',{lives:h.lives});
          io.to(ghostP.id).emit('ghost:kill_cd',{killCd:ghostP.killCd});
          if (h.lives<=0) {
            // Down the hunter instead of immediately eliminating
            h.downed=true;
            h.reviveProgress=0;
            h.flashOn=false;
            io.to(h.id).emit('hunter:downed');
            io.to(this.code).emit('hunter:down_event',{hunterId:h.id});
          }
          break; // one hit per cooldown window
        }
      }
      // Ghost cannot finish off downed players — they must be revived or the ghost wins by eliminating all active hunters
    }

    if (this.ghostHp<=0) { this.endGame('hunters'); return; }
    // Game over: all hunters are either dead OR downed with no active hunters left to revive
    const aliveHunters=hunters.filter(h=>h.alive);
    const anyActive=aliveHunters.some(h=>!h.downed);
    const anyDowned=aliveHunters.some(h=>h.downed);
    // If all alive hunters are downed and nobody can revive → ghost wins
    if (aliveHunters.length===0 || (!anyActive && anyDowned && activeHunters.length===0)) {
      // All truly dead or all downed with no reviver
      if (aliveHunters.length===0) { this.endGame('ghost'); return; }
    }
    if (hunters.length>0&&hunters.every(h=>!h.alive)) { this.endGame('ghost'); return; }

    this.broadcast(ghostSeenThisTick);
  }

  broadcast(ghostSeenThisTick) {
    const pArr=Array.from(this.players.values());
    const ghostP=pArr.find(p=>p.role==='ghost');

    const playerList=pArr.map(p=>({
      id:p.id, role:p.role, name:p.name, color:p.color,
      x:p.x, y:p.y, z:p.z, yaw:p.yaw,
      battery:p.battery, flashOn:p.flashOn,
      lives:p.lives, alive:p.alive,
      downed:p.downed||false,
      reviveProgress:p.reviveProgress||0,
      dashCd:p.dashCd||0, killCd:p.killCd||0,
    }));

    for (const recv of pArr) {
      // ghostDist: hunters get real distance, ghost gets 0 (doesn't need it)
      const ghostDist=(recv.role==='hunter' && ghostP)
        ? Math.hypot(recv.x-ghostP.x, recv.z-ghostP.z) : 0;

      io.to(recv.id).emit('game:state',{
        players: playerList,
        ghostVisible: this.ghostLitVis||ghostSeenThisTick,
        ghostMinimap: this.ghostLitMM,
        ghostHp: this.ghostHp,
        litAmt: this.litAmt,
        batteries: this.batteries,
        ghostDist,
        myId: recv.id,
      });
    }
  }

  endGame(winner) {
    if (this.phase==='ended') return;
    this.phase='ended';
    if (this.tick) { clearInterval(this.tick); this.tick=null; }
    io.to(this.code).emit('game:end',{winner,code:this.code});
    setTimeout(()=>{ if(this.phase==='ended') this.destroy(); },180000);
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
    if (r.players.size>=5) return cb({ok:false,error:'Room full'});
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
      io.to(room.code).emit('game:start',{
        players:Array.from(room.players.values()).map(p=>({
          id:p.id, role:p.role, color:p.color,
          name:p.name, lives:p.lives,
          x:p.x, y:p.y, z:p.z,
        }))
      });
    }
  });

  let _inputCount=0;
  socket.on('input',(input)=>{
    _inputCount++;
    if (!room||room.phase!=='game') return;
    const p=room.players.get(socket.id);
    if (!p) return;

    // ── DOWNED players: completely ignore ALL input ──────────────────
    // Server refuses to apply any movement, look, or flashlight changes
    if (p.downed || !p.alive) return;

    const {x,z,yaw,pitch,flashOn,attack,dash}=input;
    // Accept absolute position from client (client does collision)
    // Sanity check: max 0.25 units per tick (at 30Hz) to prevent teleporting
    const MAX_STEP = 0.25;
    if (typeof x==='number' && typeof z==='number' && isFinite(x) && isFinite(z)) {
      const dx=x-p.x, dz=z-p.z;
      const dist=Math.hypot(dx,dz);
      if (dist < MAX_STEP) {
        // Accept direct position — client already did collision
        p.x=x; p.z=z;
      } else if (dist < MAX_STEP*4) {
        // Cap movement direction but allow some movement
        const scale=MAX_STEP/dist;
        p.x+=dx*scale; p.z+=dz*scale;
      }
      // else: ignore (too far, likely lag spike)
    }
    if (typeof yaw==='number'&&isFinite(yaw)) p.yaw=yaw;
    if (typeof pitch==='number'&&isFinite(pitch)) p.pitch=Math.max(-1.05,Math.min(1.05,pitch));
    if (p.role==='hunter'&&typeof flashOn==='boolean') {
      p.flashOn=flashOn&&p.battery>0;
    }
    if (attack&&p.role==='hunter') {
      const gp=Array.from(room.players.values()).find(q=>q.role==='ghost');
      if (gp&&room.ghostStunT<=0&&ghostVisCheck(p,gp)) {
        room.ghostHp=Math.max(0,room.ghostHp-2);
        room.ghostStunT=2.0;
        io.to(room.code).emit('ghost:hit',{hp:room.ghostHp});
      }
    }
    if (dash&&p.role==='ghost'&&p.dashCd<=0) {
      // Dash: move ghost forward 1.2 units using server-side collision
      const spd=1.2;
      const ddx=Math.sin(p.yaw)*spd, ddz=Math.cos(p.yaw)*spd;
      applyMove(p,ddx,ddz);
      p.dashCd=5.0;
    }
  });

  socket.on('room:rematch',()=>{
    if (!room) return;
    if (room.phase==='ended') room.resetForRematch();
  });

  socket.on('disconnect',()=>{
    if (!room) return;
    room.removePlayer(socket.id);
    if (room.players.size>0) io.to(room.code).emit('lobby:state',{players:room.lobbyState()});
    room=null;
  });
});

const PORT=process.env.PORT||3001;
server.listen(PORT,()=>console.log(`Ghost Manor SERVER V6 :${PORT} — positions, dash 5s, E-kill, stun-while-lit`));
