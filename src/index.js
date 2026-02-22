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
    this.ghostHp=100;
    this.ghostLitVis=false; this.ghostLitMM=false;
    this.litAmt=0; this.litTimer=30+Math.random()*15;
    this.batTimer=6; this.batteries=[]; this.tick=null;
  }

  addPlayer(id, name) {
    this.players.set(id, {
      id, name, role:null, x:0, y:0, z:0,
      yaw:0, pitch:0, battery:1, flashOn:true,
      lives:3, alive:true, downed:false, ready:false, atkCd:0, killCd:0,
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
    this.ghostHp=100; this.litAmt=0;
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
    pArr[0].alive=true; pArr[0].downed=false; pArr[0].dashCd=0; pArr[0].killCd=0;

    // Spawn hunters far from ghost
    const hunterCount=pArr.length-1;
    // Set lives based on mode: 1v1=3, 2v1=2, 3v1=1
    const livesForMode=hunterCount===1?3:hunterCount===2?2:1;
    for (let i=1;i<pArr.length;i++) {
      let sp, tries=0;
      do { sp=randOpen(); tries++; } while (tries<60 && Math.hypot(sp.x-gsp.x,sp.z-gsp.z)<5*CELL);
      pArr[i].x=sp.x; pArr[i].z=sp.z; pArr[i].y=0.52*CELL;
      pArr[i].battery=1; pArr[i].flashOn=false; pArr[i].lives=livesForMode; pArr[i].alive=true; pArr[i].downed=false;
      pArr[i].atkCd=0;
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

    // ghostStunT removed - lightning no longer affects ghost, only flashlight does
    if (ghostP) {
      if (ghostP.killCd>0) ghostP.killCd=Math.max(0,ghostP.killCd-dt);
      if (ghostP.dashCd>0) ghostP.dashCd=Math.max(0,ghostP.dashCd-dt);
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

    // Hunter battery drain (server authoritative — no randomness)
    // First pass: revive mechanics, track who is reviving (they don't drain flashlight during revive)
    const revivingIds=new Set();
    for (const h of hunters) {
      if (!h.alive) continue;
      // Revive mechanics (2v1 & 3v1 only) - costs exactly 50% (2 batteries) when complete
      if (h.downed) {
        const reviver=hunters.find(r=>r.alive&&!r.downed&&r.id!==h.id&&Math.hypot(r.x-h.x,r.z-h.z)<1.2*CELL*2);
        if (reviver) {
          if (reviver.battery>=0.5) {
            revivingIds.add(reviver.id); // Reviver doesn't drain flashlight while reviving
            h.reviveProgress=(h.reviveProgress||0)+dt;
            if (h.reviveProgress>=5) {
              // Revive complete - deduct exactly 50% (0.5) from reviver
              reviver.battery=Math.max(0,reviver.battery-0.5);
              if (reviver.battery<=0) reviver.flashOn=false;
              h.downed=false;
              h.lives=1;
              h.reviveProgress=0;
              io.to(h.id).emit('hunter:revived',{lives:1});
              io.to(this.code).emit('hunter:revive_event',{hunterId:h.id,reviverId:reviver.id});
            }
          } else {
            // Reviver is trying but doesn't have enough battery → reset and warn them
            if (h.reviveProgress>0) {
              io.to(reviver.id).emit('revive:need_battery');
            }
            h.reviveProgress=0;
          }
        } else {
          h.reviveProgress=0;
        }
      }
    }
    // Second pass: flashlight drain (skip revivers - they only pay 50% at completion)
    for (const h of hunters) {
      if (!h.alive) continue;
      if (!revivingIds.has(h.id) && h.flashOn) h.battery=Math.max(0,h.battery-dt*0.08);
      if (h.battery<=0) { h.battery=0; h.flashOn=false; }
      if (h.atkCd>0) h.atkCd-=dt;
    }

    // Battery spawn & pickup — faster spawns if any hunter is under 50% battery
    this.batTimer-=dt;
    if (this.batTimer<=0&&this.batteries.length<3) {
      this.spawnBat();
      const lowHunter = hunters.some(h=>h.alive && h.battery<0.5);
      // If any alive hunter is below 50%, spawn again sooner
      this.batTimer = lowHunter ? 4+Math.random()*4 : 10+Math.random()*8;
    }
    this.batteries=this.batteries.filter(b=>{
      b.life-=dt; if(b.life<=0) return false;
      for (const h of hunters) {
        if (!h.alive) continue;
        if (Math.hypot(h.x-b.x,h.z-b.z)<0.7*CELL) { h.battery=Math.min(1,h.battery+0.25); io.to(h.id).emit('battery:pickup'); return false; }
      }
      return true;
    });

    // Ghost visibility from flashlights (recalculate each tick — no stale state)
    // Lightning does NOT affect ghost - only flashlight slows and damages
    let ghostSeenThisTick=false;
    if (ghostP) {
      for (const h of hunters) {
        if (!h.alive) continue;
        if (ghostVisCheck(h,ghostP)) {
          ghostSeenThisTick=true;
          if (h.flashOn&&h.battery>0) {
            // Only flashlight damages ghost and sets kill cooldown
            // Increased damage since battery drains faster (0.08 vs 0.013 = ~6x faster)
            this.ghostHp=Math.max(0,this.ghostHp-18*dt); // 18 HP per second (was 5)
            if (ghostP.killCd<2.0) ghostP.killCd=2.0;
          }
        }
      }
    }

    // Ghost can only kill with E key press - NO auto-kill on touch
    // Touch attack removed - ghost must press E to kill

    if (this.ghostHp<=0) { this.endGame('hunters'); return; }
    // Ghost wins if all hunters are eliminated (not just downed)
    if (hunters.length>0&&hunters.every(h=>!h.alive)) { this.endGame('ghost'); return; }
    // Ghost wins if all hunters are downed (2v1/3v1 - no one left to revive)
    if (hunters.length>=2&&hunters.every(h=>h.downed||!h.alive)) { this.endGame('ghost'); return; }

    this.broadcast(ghostSeenThisTick);
  }

  broadcast(ghostSeenThisTick) {
    const pArr=Array.from(this.players.values());
    const ghostP=pArr.find(p=>p.role==='ghost');

    // Single player list for all receivers
    const playerList=pArr.map(p=>({
      id:p.id, role:p.role, name:p.name, color:p.color,
      x:p.x, y:p.y, z:p.z, yaw:p.yaw,
      battery:p.battery, flashOn:p.flashOn,
      lives:p.lives, alive:p.alive, downed:p.downed||false,
      killCd:p.killCd||0, dashCd:p.dashCd||0,
      reviveProgress:p.reviveProgress||0,
    }));

    for (const recv of pArr) {
      const ghostDist=(!recv.role||recv.role==='hunter')&&ghostP
        ? Math.hypot(recv.x-ghostP.x, recv.z-ghostP.z) : 9999;

      io.to(recv.id).emit('game:state',{
        players: playerList,
        ghostVisible: this.ghostLitVis||ghostSeenThisTick,  // show 3D ghost blob (lightning OR flashlight)
        ghostSeenByFlashlight: ghostSeenThisTick,            // ONLY flashlight (for slow effect)
        ghostMinimap: this.ghostLitMM,                       // show on minimap
        ghostHp: this.ghostHp,
        litAmt: this.litAmt,
        batteries: this.batteries,
        ghostDist,
        myId: recv.id,
      });
    }
  }

  endGame(winner) {
    if (this.phase==='ended') {
      console.log(`[endGame] Already ended, ignoring duplicate call`);
      return;
    }
    console.log(`[endGame] Winner: ${winner}, Code: ${this.code}`);
    this.phase='ended';
    // Stop game loop immediately
    if (this.tick) { 
      clearInterval(this.tick); 
      this.tick=null; 
      console.log(`[endGame] Stopped game tick interval`);
    }
    // Emit game end to all players in the room
    io.to(this.code).emit('game:end',{winner,code:this.code});
    console.log(`[endGame] Emitted game:end to room ${this.code}, winner: ${winner}`);
    // Store timeout so we can cancel it if rematch happens
    this.destroyTimeout=setTimeout(()=>this.destroy(),30000);
  }

  destroy() {
    if (this.destroyTimeout) { clearTimeout(this.destroyTimeout); this.destroyTimeout=null; }
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
      const hunterCount=Array.from(room.players.values()).filter(p=>p.role==='hunter').length;
      io.to(room.code).emit('game:start',{
        hunterCount,
        players:Array.from(room.players.values()).map(p=>({
          id:p.id, role:p.role, color:p.color,
          name:p.name, lives:p.lives,
          x:p.x, y:p.y, z:p.z,
        }))
      });
    }
  });

  socket.on('room:rematch',()=>{
    if (!room) return;
    console.log(`[rematch] Room ${room.code} rematch requested`);
    // CRITICAL: Cancel the destroy timeout - otherwise room gets destroyed 30s after game end!
    if (room.destroyTimeout) {
      clearTimeout(room.destroyTimeout);
      room.destroyTimeout=null;
      console.log(`[rematch] Cancelled destroy timeout`);
    }
    // Stop game loop immediately
    if (room.tick) { 
      clearInterval(room.tick); 
      room.tick=null; 
      console.log(`[rematch] Stopped game tick`);
    }
    // Reset to lobby phase
    room.phase='lobby';
    // Reset all player states completely
    for (const p of room.players.values()) {
      p.ready=false; 
      p.role=null; 
      p.lives=3; 
      p.alive=true; 
      p.downed=false;
      p.battery=1; 
      p.flashOn=true; 
      p.atkCd=0; 
      p.killCd=0; 
      p.dashCd=0;
      p.reviveProgress=0;
      // Reset positions to prevent freeze
      p.x=0;
      p.z=0;
      p.y=0;
    }
    // Reset game state
    room.ghostHp=100; 
    room.batteries=[];
    room.ghostLitVis=false;
    room.ghostLitMM=false;
    room.litAmt=0;
    console.log(`[rematch] Room ${room.code} reset to lobby, emitting rematch:ready`);
    io.to(room.code).emit('rematch:ready',{code:room.code});
    io.to(room.code).emit('lobby:state',{players:room.lobbyState()});
  });

  let _inputCount=0;
  socket.on('input',(input)=>{
    _inputCount++;
    if(_inputCount<=5||_inputCount%300===0){
      const p2=room&&room.players.get(socket.id);
      console.log(`[input #${_inputCount}] from ${socket.id.slice(-4)} dx=${input.dx!=null?input.dx.toFixed(3):'?'} dz=${input.dz!=null?input.dz.toFixed(3):'?'} pos=${p2?p2.x.toFixed(2)+','+p2.z.toFixed(2):'?'} alive=${p2?.alive} downed=${p2?.downed} role=${p2?.role} phase=${room?.phase}`);
    }
    if (!room||room.phase!=='game') {
      if(_inputCount<=3) console.log(`[input] BLOCKED: room=${!!room} phase=${room?.phase}`);
      return;
    }
    const p=room.players.get(socket.id);
    if (!p) {
      if(_inputCount<=3) console.log(`[input] BLOCKED: player not found for ${socket.id.slice(-4)}`);
      return;
    }
    // Allow input processing even when downed (for yaw/pitch updates), but block movement
    if (!p.alive) {
      if(_inputCount<=3) console.log(`[input] BLOCKED: player not alive ${socket.id.slice(-4)}`);
      return;
    }
    const {dx,dz,yaw,pitch,flashOn,attack,dash,ghostKill}=input;
    const MAX=0.13;
    // Only allow movement if not downed (explicitly check for false/undefined)
    if ((p.downed===false||p.downed===undefined) && typeof dx==='number'&&typeof dz==='number') {
      const ndx=Math.max(-MAX,Math.min(MAX,dx));
      const ndz=Math.max(-MAX,Math.min(MAX,dz));
      // Apply movement if either delta is non-zero (use Math.abs to handle negative values)
      if (Math.abs(ndx)>0.001||Math.abs(ndz)>0.001) {
        const oldX=p.x, oldZ=p.z;
        applyMove(p,ndx,ndz);
        if(_inputCount<=10) console.log(`[input] MOVED ${socket.id.slice(-4)} by (${ndx.toFixed(3)},${ndz.toFixed(3)}) from (${oldX.toFixed(2)},${oldZ.toFixed(2)}) to (${p.x.toFixed(2)},${p.z.toFixed(2)})`);
      } else if(_inputCount<=10 && (Math.abs(dx)>0.001||Math.abs(dz)>0.001)) {
        console.log(`[input] MOVEMENT TOO SMALL ${socket.id.slice(-4)} dx=${dx.toFixed(4)} dz=${dz.toFixed(4)} clamped to ndx=${ndx.toFixed(4)} ndz=${ndz.toFixed(4)}`);
      }
    } else if(_inputCount<=10 && (typeof dx==='number'||typeof dz==='number')) {
      console.log(`[input] MOVEMENT BLOCKED ${socket.id.slice(-4)} downed=${p.downed} dx=${dx} dz=${dz} dxType=${typeof dx} dzType=${typeof dz}`);
    }
    // Always update yaw/pitch (even when downed, for camera)
    if (typeof yaw==='number'&&isFinite(yaw)) p.yaw=yaw;
    if (typeof pitch==='number'&&isFinite(pitch)) p.pitch=Math.max(-1.05,Math.min(1.05,pitch));
    if (p.role==='hunter'&&typeof flashOn==='boolean') {
      p.flashOn=flashOn&&p.battery>0;
    }
    if (attack&&p.role==='hunter'&&!p.downed) {
      const gp=Array.from(room.players.values()).find(q=>q.role==='ghost');
      if (gp&&ghostVisCheck(p,gp)) {
        // Hunter attack with flashlight - damages ghost and sets kill cooldown
        room.ghostHp=Math.max(0,room.ghostHp-2);
        if (gp.killCd<2.0) gp.killCd=2.0; // Set kill cooldown from flashlight attack
        io.to(room.code).emit('ghost:hit',{hp:room.ghostHp});
      }
    }
    // Handle ghost dash - increased speed
    if (dash&&p.role==='ghost'&&!p.downed&&(!p.dashCd||p.dashCd<=0)) {
      const dashDist=2.5; // Increased from 1.2 to 2.5 for faster dash
      const dsx=Math.sin(p.yaw)*dashDist, dsz=Math.cos(p.yaw)*dashDist;
      applyMove(p,dsx,dsz);
      p.dashCd=5.0;
    }
    // Handle ghost kill (E key) - only works when killCd is 0 (not on cooldown from flashlight)
    if (ghostKill&&p.role==='ghost'&&!p.downed) {
      // Check if kill is on cooldown
      if (p.killCd>0) {
        console.log(`[ghost kill] On cooldown: ${p.killCd.toFixed(2)}`);
        return; // Can't kill while on cooldown
      }
      const target=Array.from(room.players.values()).find(q=>q.role==='hunter'&&q.alive&&!q.downed);
      if (target&&Math.hypot(p.x-target.x,p.z-target.z)<0.75*CELL) {
        console.log(`[ghost kill] Killing hunter ${target.id.slice(-4)}, lives: ${target.lives}`);
        target.lives=Math.max(0,target.lives-1);
        target.atkCd=2.5;
        const hunterCount=Array.from(room.players.values()).filter(q=>q.role==='hunter').length;
        // Always emit hit first so client updates lives display
        io.to(target.id).emit('hunter:hit',{lives:target.lives});
        // Set kill cooldown BEFORE checking lives (so it works for all kills)
        p.killCd=2.0;
        if (target.lives<=0) {
          // Last life lost
          if (hunterCount>=2) {
            // 2v1 or 3v1: become downed
            target.downed=true;
            target.alive=true;
            target.reviveProgress=0; // Initialize revive progress
            io.to(target.id).emit('hunter:downed');
            io.to(room.code).emit('hunter:down_event',{hunterId:target.id});
          } else {
            // 1v1: eliminated, ghost wins immediately
            target.alive=false;
            console.log(`[ghost kill] 1v1 elimination - hunter ${target.id.slice(-4)} eliminated, ending game`);
            io.to(room.code).emit('hunter:eliminated',{hunterId:target.id});
            // End game immediately
            console.log(`[ghost kill] Calling endGame('ghost') for room ${room.code}`);
            room.endGame('ghost');
            console.log(`[ghost kill] endGame called, returning`);
            return;
          }
        } else {
          // Not last life - respawn at random location far from ghost
          let respawnSp, tries=0;
          do { respawnSp=randOpen(); tries++; } while (tries<60 && Math.hypot(respawnSp.x-p.x,respawnSp.z-p.z)<5*CELL);
          target.x=respawnSp.x; target.z=respawnSp.z;
          target.battery=1; target.flashOn=false; // flashlight OFF by default on respawn
          io.to(target.id).emit('hunter:respawn',{x:target.x,z:target.z,lives:target.lives,battery:target.battery});
        }
      } else {
        console.log(`[ghost kill] No valid target or too far away`);
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
