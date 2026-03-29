// OpenGuild.ai — Unified SPA v8
(function(){
'use strict';

const COLORS={sokrates:'#dcc050',da_vinci:'#48a8c8',sunzi:'#c88848',hypatia:'#78c848',nietzsche:'#c848a0',confucius:'#c85848',curie:'#48c890',rumi:'#a048c8',ada:'#4868c8',diogenes:'#c8c848',arendt:'#7888a0',tesla:'#5080c8'};
const INITIALS={sokrates:'Σ',da_vinci:'✦',sunzi:'兵',hypatia:'Ω',nietzsche:'N',confucius:'孔',curie:'⚛',rumi:'◎',ada:'◇',diogenes:'🏺',arendt:'H',tesla:'⚡'};

const msEl=document.getElementById('ms');
const connEl=document.getElementById('conn-dot');
const mcEl=document.getElementById('mc');
const upEl=document.getElementById('up');
const stbEl=document.getElementById('stb');

let seenIds=new Set();
let autoScroll=true;
let msgCount=0;
let topicNum=0;
let t0=Date.now();
let activeCount=0;
let agentStates=[];
let diaryEntries=[];
let diaryFilter=null;
let archetypes=[];
let currentView='chat';
let viewsLoaded={};

// ── Helpers ──
function esc(t){if(!t)return'';const d=document.createElement('div');d.textContent=t;return d.innerHTML}
function fmtTime(iso){if(!iso)return'';const d=new Date(iso.includes('T')?iso:iso+'Z');return d.toLocaleTimeString('de-CH',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function fmtDate(iso){if(!iso)return'';const d=new Date(iso);return d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}
function agColor(id){if(id?.startsWith('user:'))return'#c8a44e';return COLORS[id]||'#888'}

// ── Shared tool attachment renderer ──
function renderToolAttach(td){
  if(!td) return '';
  // Parse string JSON if needed
  if(typeof td==='string'){try{td=JSON.parse(td)}catch{return ''}}

  let parts=[];

  // Skill/tool label
  if(td.skill) parts.push(`<span class="tool-skill-label">${esc(td.skill)}</span>`);
  if(td.tool) parts.push(`<span class="tool-skill-label">${esc(td.tool)}</span>`);

  // Verdict badge (fact checker)
  if(td.verdict) parts.push(`<span class="tool-verdict tool-verdict-${td.verdict}">${td.verdict}${td.confidence?' ('+td.confidence+')':''}</span>`);

  // Search queries
  if(td.queries&&td.queries.length) parts.push(`<div class="tool-queries">${td.queries.map(q=>`<span class="tool-query">🔍 ${esc(q)}</span>`).join('')}</div>`);

  // Sources / links
  if(td.sources&&td.sources.length){
    const srcLinks=td.sources.map(s=>{
      const url=s.url||s;
      const title=s.title||url;
      return typeof url==='string'&&url.startsWith('http')?`<a href="${esc(url)}" target="_blank" class="tool-src-link">${esc(typeof title==='string'?title.slice(0,60):url)}</a>`:`<span class="tool-src-link">${esc(title)}</span>`;
    }).join('');
    parts.push(`<div class="tool-sources">${srcLinks}</div>`);
  }

  // Brain entities
  if(td.brainEntities&&td.brainEntities.length){
    parts.push(`<div class="tool-entities">${td.brainEntities.map(e=>`<span class="tool-entity">${esc(e.name)} <small>(${esc(e.type)})</small></span>`).join('')}</div>`);
  }

  // Command output (exec)
  if(td.command) parts.push(`<div class="tool-cmd"><code>$ ${esc(td.command)}</code></div>`);

  // File path
  if(td.path) parts.push(`<div class="tool-path">📄 ${esc(td.path)}</div>`);

  if(!parts.length) return '';
  return `<div class="tool-attach">${parts.join('')}</div>`;
}
function agInitial(id){if(id?.startsWith('user:'))return id.slice(5,6).toUpperCase()||'U';return INITIALS[id]||'?'}

// ── Theme ──
window.toggleTheme=function(){
  const c=document.documentElement.getAttribute('data-theme');
  const n=c==='light'?'dark':'light';
  window.applyTheme(n);
};
(function(){const s=localStorage.getItem('og-theme');
  if(s==='light'){
    const dark=document.getElementById('theme-icon-dark');
    const light=document.getElementById('theme-icon-light');
    if(dark&&light){dark.style.display='none';light.style.display=''}
  }
})();

// ── Sidebar ──
window.toggleSidebar=function(){
  const sb=document.getElementById('sidebar');
  if(window.innerWidth<=768){sb.classList.toggle('open')}
  else{sb.classList.toggle('collapsed');localStorage.setItem('og-sidebar',sb.classList.contains('collapsed')?'collapsed':'open')}
};
(function(){const s=localStorage.getItem('og-sidebar');if(s==='collapsed')document.getElementById('sidebar').classList.add('collapsed')})();

// ── View switching ──
const VIEW_TITLES={'world':'World','guild-chat':'Guild','agents':'Agents','diary':'Diary','brain':'Brain','predictions':'Predictions','quests':'Quests','tools':'Tools','skills':'Skills','settings':'Settings','profile':'Profile'};

window.switchView=function(view){
  currentView=view;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+view).classList.add('active');
  document.querySelectorAll('.sb-item').forEach(i=>i.classList.toggle('active',i.dataset.view===view));
  // Update topbar title
  const titleEl=document.getElementById('topbar-title');
  if(titleEl)titleEl.textContent=VIEW_TITLES[view]||view;
  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');
  // Lazy load view data
  if(!viewsLoaded[view]){loadView(view);viewsLoaded[view]=true}
  // Resize brain canvas when switching to it
  if(view==='brain'&&brainCanvas){setTimeout(brainResize,50);if(!brainAnim&&brainNodes.length){brainAnim=true;animBrain()}}
  // Scroll chat if switching back
  if(view==='world')setTimeout(()=>{if(autoScroll)msEl.scrollTop=msEl.scrollHeight},50);
};

async function loadView(view){
  switch(view){
    case 'guild-chat':await loadGuildMessages();break;
    case 'agents':await loadAgents();break;
    case 'diary':await loadDiary();break;
    case 'brain':await loadBrain();break;
    case 'predictions':await loadPredictions();break;
    case 'quests':await loadQuests();break;
    case 'tools':await loadTools();break;
    case 'skills':await loadSkills();break;
    case 'settings':loadSettings();break;
    case 'profile':loadProfile();break;
  }
}

// ── Chat scroll ──
msEl.addEventListener('scroll',()=>{
  const atBottom=msEl.scrollHeight-msEl.scrollTop-msEl.clientHeight<60;
  autoScroll=atBottom;
  stbEl.classList.toggle('show',!atBottom);
});
function scrollBottom(){if(autoScroll)requestAnimationFrame(()=>{msEl.scrollTop=msEl.scrollHeight})}

function addEl(html){
  const w=document.createElement('div');w.innerHTML=html;
  const el=w.firstElementChild;
  if(el)msEl.appendChild(el);
  scrollBottom();
}

// ── Chat rendering ──
function renderMsg(msg){
  if(seenIds.has(msg.id))return;
  seenIds.add(msg.id);
  msgCount++;if(mcEl)mcEl.textContent=msgCount+' msgs';
  const c=agColor(msg.agent_id),i=agInitial(msg.agent_id),time=fmtTime(msg.created_at);
  const srcHtml=msg.news_link?`<div class="msg-src"><a href="${esc(msg.news_link)}" target="_blank">📰 ${esc(msg.news_context)}</a></div>`:(msg.news_context?`<div class="msg-src"><span>📰 ${esc(msg.news_context)}</span></div>`:'');
  const tokIn=msg.tokens_in||0,tokOut=msg.tokens_out||0;
  const tokHtml=(tokIn||tokOut)?`<span class="msg-tokens">${tokIn}→${tokOut}tk</span>`:'';
  const avatarHtml=`<div class="mv" style="background:${c}">${i}</div>`;
  const toolHtml=renderToolAttach(msg.tool_data);
  addEl(`<div class="msg" id="msg-${msg.id}"><div class="mh">${avatarHtml}<span class="mn" style="color:${c}">${esc(msg.agent_name)}</span>${tokHtml}<span class="mt">${time}</span></div><div class="mb">${esc(msg.content)}</div>${toolHtml}${srcHtml}</div>`);
}

function renderNews(news){
  topicNum++;
  const linkHtml=news.link?`<a href="${esc(news.link)}" target="_blank">Read →</a>`:'';
  addEl(`<div class="nw"><div class="nl">📰 ${esc(news.feed_source)} · Breaking</div><div class="nt">${esc(news.title)}</div>${news.summary?`<div class="ns">${esc(news.summary.slice(0,180))}</div>`:''}${linkHtml}</div>`);
}

function renderJournal(j){
  addEl(`<div class="journal-msg"><div class="jl">📔 ${esc(j.agent_name)} returned</div><div class="jt">${esc(j.summary)}</div></div>`);
}

function renderTyping(data){
  document.querySelectorAll('.tp').forEach(e=>e.remove());
  const c=agColor(data.agent_id),i=agInitial(data.agent_id);
  addEl(`<div class="tp"><div class="mv" style="background:${c}">${i}</div><div class="tpd"><span></span><span></span><span></span></div><span class="tpn">${esc(data.agent_name)} composing...</span></div>`);
}
function hideTyping(){document.querySelectorAll('.tp').forEach(e=>e.remove())}

// ── Ticker ──
// ── Uptime ──
setInterval(()=>{
  const s=Math.floor((Date.now()-t0)/1000),m=Math.floor(s/60),h=Math.floor(m/60);
  if(upEl)upEl.textContent=`${String(h).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
},1000);

// ── Load chat history ──
async function loadMessages(){
  try{
    const res=await fetch('/api/messages?limit=100');if(!res.ok)return;
    const msgs=await res.json();
    if(msgs.length>0){const w=msEl.querySelector('.sy');if(w)w.remove()}
    for(const msg of msgs)renderMsg(msg);
  }catch(err){console.error('Load failed:',err)}
}

// ── SSE ──
function connectSSE(){
  connEl.className='sb-pulse dead';
  const es=new EventSource('/api/events');
  es.onopen=()=>{connEl.className='sb-pulse live'};
  es.onmessage=(e)=>{
    try{
      const{type,payload}=JSON.parse(e.data);
      switch(type){
        case 'chat':hideTyping();renderMsg(payload);break;
        case 'news':renderNews(payload);break;
        case 'typing':renderTyping(payload);break;
        case 'state':
          agentStates=payload;
          activeCount=payload.filter(a=>a.status==='active').length;
          if(viewsLoaded.agents)renderAgentsGrid();
          break;
        case 'journal':renderJournal(payload);break;
        case 'guild-chat':renderGuildMsg(payload);break;
        case 'guild-typing':renderGuildTyping(payload);break;
        case 'guild-typing-done':hideGuildTyping();break;
      }
    }catch(err){console.error('[SSE]',err)}
  };
  es.onerror=()=>{connEl.className='sb-pulse dead';es.close();setTimeout(connectSSE,2000)};
}

// ══════════════════════════════════
// AGENTS VIEW
// ══════════════════════════════════
async function loadAgents(){
  const res=await fetch('/api/archetypes');archetypes=await res.json();
  renderAgentsGrid();
}

function renderAgentsGrid(){
  // Don't re-render if agent detail is open — it would kill the detail view
  const detail=document.getElementById('agent-detail-inline');
  if(detail&&detail.style.display==='block')return;
  const stateMap={};agentStates.forEach(s=>{stateMap[s.agent_id]=s});
  const active=agentStates.filter(s=>s.status==='active').length;
  const guild=agentStates.filter(s=>s.status==='guild').length;
  const resting=agentStates.filter(s=>s.status==='resting').length;
  const totalMsgs=agentStates.reduce((a,s)=>a+(s.messages_sent||0),0);

  document.getElementById('agent-stats').innerHTML=
    `<div class="stat-card"><div class="stat-v">${active||'—'}</div><div class="stat-l">World</div></div>
     <div class="stat-card"><div class="stat-v">${guild||'—'}</div><div class="stat-l">Guild</div></div>
     <div class="stat-card"><div class="stat-v">${resting||'—'}</div><div class="stat-l">Resting</div></div>
     <div class="stat-card"><div class="stat-v">${totalMsgs||'—'}</div><div class="stat-l">Messages</div></div>`;

  document.getElementById('agents-grid').innerHTML=archetypes.map(a=>{
    const c=COLORS[a.id]||'#888',i=INITIALS[a.id]||'?',st=stateMap[a.id]||{};
    const status=st.status||'idle',pct=Math.round((1-(st.progress||0))*100);
    const ec=pct>50?'var(--green)':pct>20?'var(--accent)':'var(--red)';
    const timeLabel=status==='resting'?'resting':status==='guild'?'guild':status==='active'?'world':'—';
    return `<div class="agent-card" onclick="event.stopPropagation();showAgentDetail('${a.id}')"><div class="accent-bar" style="background:${c}"></div><div class="agent-top"><div class="agent-avatar" style="background:${c}">${i}</div><div class="agent-info"><div class="agent-name" style="color:${c}">${esc(a.name)}</div><div class="agent-title">${esc(a.title||'')}</div></div><div class="agent-status"><span class="status-dot ${status}"></span>${timeLabel}</div></div><div class="agent-desc">${esc((a.personality||'').slice(0,120))}</div><div class="agent-meta"><span>💬 ${st.messages_sent||0}</span><div class="energy-bar"><div class="energy-fill" style="width:${pct}%;background:${ec}"></div></div><span>${pct}%</span></div></div>`;
  }).join('');
}

// ══════════════════════════════════
// DIARY VIEW
// ══════════════════════════════════
let diaryData={};

async function loadDiary(){
  const res=await fetch('/api/diary');
  diaryData=await res.json();
  // If empty, trigger generation for today
  if(!Object.keys(diaryData).length){
    fetch('/api/diary/generate',{method:'POST'}).then(()=>{
      setTimeout(async()=>{const r=await fetch('/api/diary');diaryData=await r.json();renderDiaryView()},15000);
    });
  }
  renderDiaryView();
}

function renderDiaryView(){
  const days=Object.keys(diaryData).sort().reverse();
  const list=document.getElementById('diary-list');

  if(!days.length){
    list.innerHTML='<div class="empty-state">No diary entries yet. Agents write daily summaries at end of day.</div>';
    return;
  }

  // Collect all agents for filter
  const allAgents=new Set();
  for(const d of days)(diaryData[d]||[]).forEach(e=>allAgents.add(e.agent_id));

  // Render filters
  const filEl=document.getElementById('diary-filters');
  filEl.innerHTML=`<button class="filter-btn ${!diaryFilter?'active':''}" onclick="setDiaryFilter(null)">All</button>`+
    [...allAgents].map(id=>{
      const name=(diaryData[days[0]]||[]).find(e=>e.agent_id===id)?.agent_name||id;
      const c=COLORS[id]||'#888';
      return `<button class="filter-btn ${diaryFilter===id?'active':''}" onclick="setDiaryFilter('${id}')" style="border-color:${c}40">${esc(name)}</button>`;
    }).join('');

  // Render days
  list.innerHTML=`<div class="diary-inner">${days.map(day=>{
    let entries=diaryData[day]||[];
    if(diaryFilter)entries=entries.filter(e=>e.agent_id===diaryFilter);
    if(!entries.length)return'';

    const dayLabel=new Date(day+'T12:00:00Z').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

    return `<div class="diary-day">
      <div class="diary-day-header">${dayLabel}</div>
      ${entries.map(e=>{
        const c=COLORS[e.agent_id]||'#888',i=INITIALS[e.agent_id]||'?';
        return `<div class="diary-entry">
          <div class="diary-entry-head">
            <div class="diary-avatar" style="background:${c}">${i}</div>
            <span class="diary-name" style="color:${c}">${esc(e.agent_name)}</span>
          </div>
          <div class="diary-body">
            <div class="diary-text">${esc(e.summary)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('')}</div>`;
}

window.setDiaryFilter=function(agent){diaryFilter=agent;renderDiaryView()};

// ══════════════════════════════════
// INTEL VIEW
// ══════════════════════════════════
async function loadIntel(){
  const res=await fetch('/api/categories');
  const data=await res.json();
  const el=document.getElementById('intel-content');
  if(!data.length){el.innerHTML='<div class="empty-state">No categorized news yet.</div>';return}
  el.innerHTML=data.map(cat=>`<div class="intel-cat"><div class="intel-cat-header">${esc(cat.category)} · ${cat.items.length}</div>${cat.items.slice(0,10).map(item=>`<div class="intel-item"><div class="intel-title">${item.link?`<a href="${esc(item.link)}" target="_blank">${esc(item.title)}</a>`:esc(item.title)}</div><div class="intel-meta">${esc(item.feed_source||'')} · ${fmtDate(item.fetched_at)}</div></div>`).join('')}</div>`).join('');
}

// ══════════════════════════════════
// BRAIN VIEW
// ══════════════════════════════════
let brainNodes=[],brainEdges=[],brainCanvas,brainCtx,brainAnim=false;
let brainArtifactNodes=[];
let brainEventsInit=false;
let panX=0,panY=0,zoom=1,isPanning=false,panStart={x:0,y:0};
let selectedNode=null;
const TYPE_COLORS={person:'#c848a0',country:'#5080c8',org:'#c8a44e',technology:'#48a8c8',event:'#c85050',concept:'#78c848',region:'#c88848',policy:'#7888a0'};
const STATUS_COLORS={pending:'#666',validating:'#c8a44e',validated:'#48c878',rejected:'#c85050'};

async function loadBrain(){
  const res=await fetch('/api/brain');const data=await res.json();
  document.getElementById('brain-stats').innerHTML=
    `<b>${data.stats.entities}</b> entities · <b>${data.stats.connections}</b> connections · <b>${data.stats.topics}</b> topics · <span class="brain-artifacts-toggle" onclick="toggleArtifactsPanel()"><b>${data.stats.artifacts||0}</b> artifacts</span>`;

  brainCanvas=document.getElementById('brain-canvas');
  brainCtx=brainCanvas.getContext('2d');

  setTimeout(()=>{
    brainResize();
    initBrainGraph(data);
    if(!brainAnim){brainAnim=true;animBrain()}
  },50);

  // Only bind events ONCE
  if(!brainEventsInit){
    brainEventsInit=true;
    window.addEventListener('resize',brainResize);

    brainCanvas.addEventListener('wheel',(e)=>{e.preventDefault();zoom*=e.deltaY>0?.92:1.08;zoom=Math.max(.3,Math.min(4,zoom))},{passive:false});
    brainCanvas.addEventListener('mousedown',(e)=>{isPanning=true;panStart={x:e.clientX-panX,y:e.clientY-panY};brainCanvas.style.cursor='grabbing'});
    brainCanvas.addEventListener('mousemove',(e)=>{if(isPanning){panX=e.clientX-panStart.x;panY=e.clientY-panStart.y}});
    brainCanvas.addEventListener('mouseup',()=>{isPanning=false;brainCanvas.style.cursor='grab'});
    brainCanvas.addEventListener('mouseleave',()=>{isPanning=false;brainCanvas.style.cursor='grab'});
    brainCanvas.style.cursor='grab';

    brainCanvas.addEventListener('click',(e)=>{
      if(isPanning)return;
      const rect=brainCanvas.getBoundingClientRect();
      const mx=(e.clientX-rect.left-panX)/zoom,my=(e.clientY-rect.top-panY)/zoom;
      let hit=null;
      for(const n of brainArtifactNodes){
        const dx=n.x-mx,dy=n.y-my;
        if(Math.abs(dx)<n.r+8&&Math.abs(dy)<n.r+8){hit=n;break}
      }
      if(!hit){
        for(const n of brainNodes){
          const dx=n.x-mx,dy=n.y-my;
          if(dx*dx+dy*dy<(n.r+10)*(n.r+10)){hit=n;break}
        }
      }
      selectedNode=hit;
      if(hit){
        if(hit.isArtifact) showArtifactDetail(hit.artifactId);
        else showBrainDetail(hit.name);
      } else closeBrainDetail();
    });

    let touchStart=null;
    brainCanvas.addEventListener('touchstart',(e)=>{if(e.touches.length===1){touchStart={x:e.touches[0].clientX-panX,y:e.touches[0].clientY-panY}}},{passive:true});
    brainCanvas.addEventListener('touchmove',(e)=>{if(e.touches.length===1&&touchStart){panX=e.touches[0].clientX-touchStart.x;panY=e.touches[0].clientY-touchStart.y}},{passive:true});
    brainCanvas.addEventListener('touchend',()=>{touchStart=null});
  }

  fetch('/api/brain/backfill',{method:'POST'}).catch(()=>{});
}

function brainResize(){
  if(!brainCanvas)return;
  const wrap=brainCanvas.parentElement;
  brainCanvas.width=wrap.clientWidth||800;
  brainCanvas.height=wrap.clientHeight||500;
}

function initBrainGraph(data){
  const w=brainCanvas.width,h=brainCanvas.height;
  brainNodes=data.entities.map((e,idx)=>{
    const angle=idx/data.entities.length*Math.PI*2,r=Math.min(w,h)*0.3+Math.random()*60;
    return{id:e.id,name:e.name,type:e.type,mentions:e.mention_count,
      x:w/2+Math.cos(angle)*r,y:h/2+Math.sin(angle)*r,
      vx:0,vy:0,r:Math.max(5,Math.min(14,e.mention_count*2)),
      color:TYPE_COLORS[e.type]||'#888',isArtifact:false,
      verified:e.verified||0,confidence:e.confidence||null};
  });
  brainEdges=data.connections.map(c=>({
    from:brainNodes.find(n=>n.name===c.from_name),
    to:brainNodes.find(n=>n.name===c.to_name),
    rel:c.relation,strength:c.strength,
    verified:c.verified||0
  })).filter(e=>e.from&&e.to);

  // Add artifact nodes (diamonds) — fetch separately
  fetch('/api/brain/artifacts').then(r=>r.json()).then(artifacts=>{
    brainArtifactNodes=(artifacts.filter(a=>a.validation_status!=='validated')).map((a,idx)=>{
      const angle=(idx/Math.max(1,artifacts.length))*Math.PI*2;
      const dist=Math.min(w,h)*0.15+Math.random()*30;
      return{
        artifactId:a.id,name:a.title||a.filename,
        status:a.validation_status||'pending',
        x:w/2+Math.cos(angle)*dist,y:h/2+Math.sin(angle)*dist,
        vx:0,vy:0,r:10,
        color:STATUS_COLORS[a.validation_status]||'#c8a44e',
        isArtifact:true
      };
    });
  }).catch(()=>{});
}

function brainSimulate(){
  // Only simulate entity nodes (not artifacts — they're static position)
  const nodes=brainNodes;
  const len=nodes.length;
  for(let i=0;i<len;i++){nodes[i].vx*=.9;nodes[i].vy*=.9}
  for(let i=0;i<len;i++){
    const ni=nodes[i];
    for(let j=i+1;j<len;j++){
      const nj=nodes[j];
      let dx=nj.x-ni.x,dy=nj.y-ni.y;
      const dist=Math.max(1,Math.sqrt(dx*dx+dy*dy)),f=4000/(dist*dist);
      dx/=dist;dy/=dist;
      ni.vx-=dx*f;ni.vy-=dy*f;
      nj.vx+=dx*f;nj.vy+=dy*f;
    }
  }
  for(const e of brainEdges){
    let dx=e.to.x-e.from.x,dy=e.to.y-e.from.y;
    const dist=Math.max(1,Math.sqrt(dx*dx+dy*dy)),f=(dist-100)*.008*e.strength;
    dx/=dist;dy/=dist;
    e.from.vx+=dx*f;e.from.vy+=dy*f;e.to.vx-=dx*f;e.to.vy-=dy*f;
  }
  const cx=brainCanvas.width/2,cy=brainCanvas.height/2;
  for(let i=0;i<len;i++){const n=nodes[i];n.vx+=(cx-n.x)*.0004;n.vy+=(cy-n.y)*.0004;n.x+=n.vx;n.y+=n.vy}
  // Gently pull artifact nodes toward center too
  for(const a of brainArtifactNodes){a.vx*=.95;a.vy*=.95;a.vx+=(cx-a.x)*.001;a.vy+=(cy-a.y)*.001;a.x+=a.vx;a.y+=a.vy}
}

function brainDraw(){
  const bg=getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const dimColor=getComputedStyle(document.documentElement).getPropertyValue('--dim').trim();
  const textColor=getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
  brainCtx.fillStyle=bg;brainCtx.fillRect(0,0,brainCanvas.width,brainCanvas.height);
  brainCtx.save();brainCtx.translate(panX,panY);brainCtx.scale(zoom,zoom);

  // Edges
  for(const e of brainEdges){
    brainCtx.beginPath();brainCtx.moveTo(e.from.x,e.from.y);brainCtx.lineTo(e.to.x,e.to.y);
    const isSelected=selectedNode&&(e.from===selectedNode||e.to===selectedNode);
    const isVerified=e.verified||false;
    brainCtx.strokeStyle=isSelected?'#ffffffcc':isVerified?'#ffffff90':'#ffffff30';
    brainCtx.lineWidth=isSelected?Math.max(1.5,e.strength):isVerified?Math.max(1,e.strength*1.2):Math.max(.3,e.strength*.4);
    brainCtx.stroke();
    if(zoom>.6){
      const mx=(e.from.x+e.to.x)/2,my=(e.from.y+e.to.y)/2;
      brainCtx.fillStyle=dimColor;brainCtx.font='8px DM Mono';brainCtx.textAlign='center';
      brainCtx.fillText(e.rel,mx,my-3);
    }
  }

  // Nodes
  for(const n of brainNodes){
    const isSel=n===selectedNode;
    const isConn=selectedNode&&brainEdges.some(e=>(e.from===selectedNode&&e.to===n)||(e.to===selectedNode&&e.from===n));
    const alpha=selectedNode?(isSel||isConn?'ff':'40'):'cc';

    // Glow
    const g=brainCtx.createRadialGradient(n.x,n.y,0,n.x,n.y,n.r*2.5);
    g.addColorStop(0,n.color+(isSel?'30':'12'));g.addColorStop(1,'transparent');
    brainCtx.fillStyle=g;brainCtx.fillRect(n.x-n.r*3,n.y-n.r*3,n.r*6,n.r*6);

    // Circle
    brainCtx.beginPath();brainCtx.arc(n.x,n.y,isSel?n.r*1.3:n.r,0,Math.PI*2);
    brainCtx.fillStyle=n.color+alpha;brainCtx.fill();
    if(isSel){brainCtx.strokeStyle=n.color;brainCtx.lineWidth=2;brainCtx.stroke()}

    // Label
    const fontSize=isSel?Math.max(11,n.r+2):Math.max(9,n.r);
    brainCtx.fillStyle=isSel||isConn||!selectedNode?textColor:dimColor;
    brainCtx.font=(isSel?'500 ':'400 ')+fontSize+'px DM Mono';brainCtx.textAlign='center';
    brainCtx.fillText(n.name,n.x,n.y+n.r+12);
    if(isSel){
      brainCtx.fillStyle=dimColor;brainCtx.font='8px DM Mono';
      brainCtx.fillText(n.type+' · ×'+n.mentions+(n.verified?' ✓':''),n.x,n.y+n.r+22);
    }
    // Verified badge
    if(n.verified&&!isSel){
      brainCtx.fillStyle='#48c878';brainCtx.font='bold 8px DM Mono';brainCtx.textAlign='center';
      brainCtx.fillText('✓',n.x+n.r+4,n.y-n.r+4);
    }
  }

  // Artifact nodes (diamonds)
  for(const a of brainArtifactNodes){
    const isSel=a===selectedNode;
    const alpha=selectedNode?(isSel?'ff':'40'):'cc';
    const r=isSel?a.r*1.4:a.r;
    const col=a.color;

    // Pulsing glow for validating status
    let glowAlpha='15';
    if(a.status==='validating'){
      glowAlpha=Math.floor(15+10*Math.sin(Date.now()/300)).toString(16).padStart(2,'0');
    }

    // Glow
    const g=brainCtx.createRadialGradient(a.x,a.y,0,a.x,a.y,r*3);
    g.addColorStop(0,col+glowAlpha);g.addColorStop(1,'transparent');
    brainCtx.fillStyle=g;brainCtx.fillRect(a.x-r*4,a.y-r*4,r*8,r*8);

    // Diamond shape
    brainCtx.beginPath();
    brainCtx.moveTo(a.x,a.y-r);brainCtx.lineTo(a.x+r,a.y);
    brainCtx.lineTo(a.x,a.y+r);brainCtx.lineTo(a.x-r,a.y);
    brainCtx.closePath();
    brainCtx.fillStyle=col+alpha;brainCtx.fill();
    if(isSel){brainCtx.strokeStyle=col;brainCtx.lineWidth=2;brainCtx.stroke()}

    // Label
    const fontSize=isSel?11:9;
    brainCtx.fillStyle=isSel||!selectedNode?textColor:dimColor;
    brainCtx.font=(isSel?'500 ':'400 ')+fontSize+'px DM Mono';brainCtx.textAlign='center';
    const label=a.name.length>25?a.name.slice(0,22)+'…':a.name;
    brainCtx.fillText(label,a.x,a.y+r+12);
    if(isSel){
      brainCtx.fillStyle=dimColor;brainCtx.font='8px DM Mono';
      brainCtx.fillText('artifact · '+a.status,a.x,a.y+r+22);
    }
  }

  brainCtx.restore();
}

let brainFrame=0;
function animBrain(){
  if(!brainCanvas||!brainNodes.length||currentView!=='brain'){brainAnim=false;return}
  brainFrame++;
  // Simulate every 2nd frame to save CPU
  if(brainFrame%2===0)brainSimulate();
  brainDraw();
  requestAnimationFrame(animBrain);
}

// ── Brain Detail Panel ──
async function showBrainDetail(name){
  const panel=document.getElementById('brain-detail');
  panel.classList.add('open');
  panel.innerHTML='<div style="padding:1rem;font-size:.7rem;color:var(--dim)">Loading...</div>';

  try{
    const res=await fetch('/api/brain/entity/'+encodeURIComponent(name));
    if(!res.ok){panel.innerHTML='<div style="padding:1rem;font-size:.7rem;color:var(--dim)">Not found.</div>';return}
    const data=await res.json();
    const e=data.entity;
    const c=TYPE_COLORS[e.type]||'#888';

    panel.innerHTML=`
      <div class="bd-header" style="position:relative">
        <button class="bd-close" onclick="closeBrainDetail()">✕</button>
        <div class="bd-name" style="color:${c}">${esc(e.name)}</div>
        <span class="bd-type bd-type-${e.type}">${e.type}</span>
        <div class="bd-meta">×${e.mention_count} mentions · since ${(e.first_seen||'').split('T')[0]||'—'}</div>
      </div>
      ${data.connections.length?`<div class="bd-section">
        <div class="bd-section-label">Connections (${data.connections.length})</div>
        ${data.connections.map(c2=>{
          const cc=TYPE_COLORS[c2.connected_type]||'#888';
          return `<div class="bd-conn" onclick="selectBrainNode('${esc(c2.connected_to)}')">
            <div class="bd-conn-dot" style="background:${cc}"></div>
            ${esc(c2.connected_to)}
            <span class="bd-conn-rel">${esc(c2.relation)} ×${c2.strength}</span>
          </div>`;
        }).join('')}
      </div>`:''}
      ${data.news.length?`<div class="bd-section">
        <div class="bd-section-label">Related News (${data.news.length})</div>
        ${data.news.map(n=>`<div class="bd-news">
          <a href="${esc(n.link||'#')}" target="_blank">${esc(n.title)}</a>
          <div class="bd-news-src">${esc(n.feed_source||'')}</div>
        </div>`).join('')}
      </div>`:''}
    `;
  }catch(err){
    panel.innerHTML='<div style="padding:1rem;font-size:.7rem;color:var(--dim)">Error loading details.</div>';
  }
}

function closeBrainDetail(){
  document.getElementById('brain-detail').classList.remove('open');
  selectedNode=null;
}
window.closeBrainDetail=closeBrainDetail;

window.selectBrainNode=function(name){
  const node=brainNodes.find(n=>n.name===name);
  if(node){
    selectedNode=node;
    panX=brainCanvas.width/2-node.x*zoom;
    panY=brainCanvas.height/2-node.y*zoom;
    showBrainDetail(name);
  }
};

// ── Brain Artifacts Panel ──
async function loadBrainArtifacts(){
  const panel=document.getElementById('brain-artifacts-panel');
  if(!panel)return;
  try{
    const res=await fetch('/api/brain/artifacts');
    const allArtifacts=await res.json();
    // Split: active (pending/validating) vs archive (validated)
    const active=allArtifacts.filter(a=>a.validation_status!=='validated');
    const archived=allArtifacts.filter(a=>a.validation_status==='validated');

    panel.innerHTML=`
      <div class="ba-header">
        <span class="ba-title">Artifacts (${active.length})</span>
        <input class="ba-search" type="text" placeholder="Search…" oninput="filterArtifacts(this.value)">
      </div>
      <div class="ba-list" id="ba-list">
        ${active.length?active.map(a=>renderArtifactCard(a)).join(''):'<div class="ba-empty">No pending artifacts</div>'}
      </div>
      ${archived.length?`
        <div class="ba-archive-toggle" onclick="toggleArchive()">📦 Archive (${archived.length})</div>
        <div class="ba-archive" id="ba-archive" style="display:none">
          ${archived.map(a=>renderArtifactCard(a)).join('')}
        </div>`:''}`;
  }catch(e){panel.innerHTML='<div class="ba-empty">Error loading artifacts</div>'}
}

function renderArtifactCard(a){
  return `<div class="ba-card ba-status-${a.validation_status||'pending'}" data-title="${esc(a.title||a.filename).toLowerCase()}" onclick="showArtifactDetail(${a.id})">
    <div class="ba-card-title">${esc(a.title||a.filename)}</div>
    <div class="ba-card-meta">
      <span class="ba-badge ba-badge-${a.validation_status||'pending'}">${a.validation_status||'pending'}</span>
      <span class="ba-date">${(a.created_at||'').split('T')[0]||'—'}</span>
    </div>
    ${a.agent_ids?`<div class="ba-agents">${a.agent_ids.split(',').map(id=>{const ar=window._archetypes?.find(x=>x.id===id.trim());return ar?`<span class="ba-agent-dot" style="background:${ar.color}" title="${ar.name}"></span>`:`<span class="ba-agent-dot" title="${id.trim()}"></span>`}).join('')}</div>`:''}
  </div>`;
}

window.toggleArchive=function(){
  const el=document.getElementById('ba-archive');
  if(el)el.style.display=el.style.display==='none'?'block':'none';
};

window.toggleArtifactsPanel=function(){
  const panel=document.getElementById('brain-artifacts-panel');
  if(!panel)return;
  const visible=panel.style.display!=='none';
  panel.style.display=visible?'none':'flex';
  if(!visible)loadBrainArtifacts();
};

window.filterArtifacts=function(q){
  const cards=document.querySelectorAll('#ba-list .ba-card');
  const query=q.toLowerCase();
  cards.forEach(c=>{c.style.display=c.dataset.title.includes(query)?'':'none'});
};

// ══════════════════════════════════
// Agent Detail View — inline (replaces grid when open)
// ══════════════════════════════════
window.showAgentDetail=async function(agentId){
  const container=document.getElementById('agent-detail-inline');
  const grid=document.getElementById('agents-grid');
  if(!container)return;

  grid.style.display='none';
  container.style.display='block';
  container.innerHTML='<div class="ad-loading">Loading agent...</div>';

  try{
    const res=await fetch(`/api/agents/${agentId}`);
    const a=await res.json();
    if(a.error){closeAgentDetail();return}

    const c=a.color||'#888';
    const modesHtml=(a.modes||[]).map((m,i)=>`
      <div class="ad-mode">
        <div class="ad-mode-header">
          <span class="ad-mode-weight">w:${m.w}</span>
          <span class="ad-mode-idx">Mode ${i+1}</span>
        </div>
        <textarea class="ad-mode-text" data-idx="${i}" rows="2">${esc(m.instruction||'')}</textarea>
      </div>`).join('');

    const energyPct=a.state?Math.round((1-(a.state.progress||0))*100):100;

    container.innerHTML=`
      <div class="ad-header" style="border-color:${c}">
        <button class="ad-close" onclick="closeAgentDetail()">← Back</button>
        <div class="ad-avatar" style="background:${c}">${a.avatar||'?'}</div>
        <div class="ad-info">
          <div class="ad-name" style="color:${c}">${esc(a.name)}</div>
          <div class="ad-title">${esc(a.title||'')} · inspired by ${esc(a.inspired_by||'')}</div>
        </div>
        <button class="ad-btn ad-btn-save" onclick="saveAgentChanges('${agentId}')">💾 Save</button>
        <button class="ad-btn ad-btn-apply" onclick="applyAgentChanges('${agentId}')">✓ Apply</button>
      </div>

      <div class="ad-section">
        <label class="ad-label">Personality Prompt</label>
        <textarea class="ad-textarea" id="ad-personality" rows="4">${esc(a.personality||'')}</textarea>
      </div>

      <div class="ad-section">
        <label class="ad-label">Discussion Prompt</label>
        <textarea class="ad-textarea" id="ad-discussion" rows="4">${esc(a.discussionPrompt||'')}</textarea>
      </div>

      <div class="ad-section">
        <label class="ad-label">Response Modes (${(a.modes||[]).length})</label>
        <div class="ad-modes">${modesHtml}</div>
      </div>

      <div class="ad-section">
        <label class="ad-label">Interests</label>
        <div class="ad-interests">${(a.interests||[]).map(i=>`<span class="ad-tag">${esc(i)}</span>`).join('')}</div>
      </div>

      <div class="ad-section">
        <label class="ad-label">Energy</label>
        <div class="ad-energy">
          <div class="energy-bar" style="width:100%"><div class="energy-fill" style="width:${energyPct}%;background:${c}"></div></div>
          <span class="ad-energy-text">${energyPct}% · max:${a.energy_profile?.max||'?'} · regen:${a.energy_profile?.regen_rate||'?'}/tick · cost:${a.energy_profile?.write_cost||'?'}/msg</span>
        </div>
      </div>

      ${a.state?`<div class="ad-section">
        <label class="ad-label">State</label>
        <div class="ad-state">
          <span>Status: ${a.state.status||'idle'}</span> ·
          <span>Messages: ${a.state.messages_sent||0}</span> ·
          <span>Mood: ${a.state.mood||'—'}</span>
        </div>
      </div>`:''}`;
  }catch(e){
    container.innerHTML=`<div class="ad-loading">Error: ${e.message}</div>`;
  }
};

window.closeAgentDetail=function(){
  const container=document.getElementById('agent-detail-inline');
  const grid=document.getElementById('agents-grid');
  if(container)container.style.display='none';
  if(grid)grid.style.display='';
};

window.applyAgentChanges=async function(agentId){
  const personality=document.getElementById('ad-personality')?.value;
  const discussion=document.getElementById('ad-discussion')?.value;
  const modeEls=document.querySelectorAll('.ad-mode-text');
  const modes=[];
  modeEls.forEach(el=>{
    const idx=parseInt(el.dataset.idx);
    const w=parseInt(el.closest('.ad-mode')?.querySelector('.ad-mode-weight')?.textContent?.replace('w:','')||'10');
    modes[idx]={w,instruction:el.value};
  });

  await fetch(`/api/agents/${agentId}`,{
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({personality,discussionPrompt:discussion,modes:modes.filter(Boolean)})
  });
  document.querySelector('.ad-btn-apply').textContent='✓ Applied';
  setTimeout(()=>{document.querySelector('.ad-btn-apply').textContent='Apply (runtime)'},2000);
};

window.saveAgentChanges=async function(agentId){
  const personality=document.getElementById('ad-personality')?.value;
  const discussion=document.getElementById('ad-discussion')?.value;

  const res=await fetch(`/api/agents/${agentId}/save`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({personality,discussionPrompt:discussion})
  });
  const data=await res.json();
  const btn=document.querySelector('.ad-btn-save');
  btn.textContent=data.ok?'✓ Saved to disk':'❌ Error';
  setTimeout(()=>{btn.textContent='💾 Save to disk'},2000);
};

window.showArtifactDetail=async function(id){
  const panel=document.getElementById('brain-detail');
  panel.classList.add('open');
  panel.innerHTML='<div style="padding:1rem;font-size:.7rem;color:var(--dim)">Loading report...</div>';
  try{
    const res=await fetch(`/api/brain/artifacts/${id}`);
    if(!res.ok){panel.innerHTML='<div style="padding:1rem">Not found</div>';return}
    const a=await res.json();
    const sc=STATUS_COLORS[a.validation_status]||'#888';

    // Parse .md content into sections
    const sections=parseMarkdownSections(a.content||'');

    // Render agents
    const agentsHtml=a.agents?.length?`<div class="ar-agents">${a.agents.map(ag=>`<span class="ar-agent" style="border-color:${ag.color||'#888'}"><span class="ar-agent-avatar">${ag.avatar||'?'}</span> ${esc(ag.name||ag.id)}</span>`).join('')}</div>`:'';

    // Render content sections
    const contentHtml=sections.map(s=>{
      if(s.level===1)return `<div class="ar-title">${esc(s.text)}</div>`;
      if(s.level===2)return `<div class="ar-section-label">${esc(s.text)}</div><div class="ar-section-body">${renderMdBlock(s.body)}</div>`;
      return `<div class="ar-body">${renderMdBlock(s.body)}</div>`;
    }).join('');

    // Render validations
    const valsHtml=a.validations?.length?a.validations.map(v=>`
      <div class="ba-vote ba-vote-${v.vote}">
        <span class="ba-vote-agent" style="color:${v.agent_color||'#888'}">${esc(v.agent_name||v.agent_id)}</span>
        <span class="ba-vote-badge">${v.vote==='approve'?'✓':'✗'} ${v.vote}</span>
        <div class="ba-vote-reason">${esc(v.reasoning||'')}</div>
        ${v.facts_checked?`<div class="ba-vote-facts">${v.facts_verified}/${v.facts_checked} facts verified</div>`:''}
      </div>`).join(''):'';

    panel.innerHTML=`
      <div class="bd-header" style="position:relative">
        <button class="bd-close" onclick="closeBrainDetail()">✕</button>
        <div class="bd-name" style="color:${sc}">◆ ${esc(a.title||a.filename)}</div>
        <span class="ba-badge ba-badge-${a.validation_status}" style="margin-top:4px;display:inline-block">${a.validation_status}</span>
        <div class="bd-meta">${(a.created_at||'').split('T')[0]||'—'}${a.quest?` · Quest #${a.quest.id}`:''}</div>
        ${agentsHtml}
      </div>
      <div class="ar-content">${contentHtml}</div>
      ${valsHtml?`<div class="bd-section"><div class="bd-section-label">Validation (${a.validations.length})</div>${valsHtml}</div>`:''}
      <div class="bd-section" style="display:flex;gap:.3rem">
        <button class="ba-validate-btn" onclick="triggerValidation(${id})">Validate</button>
      </div>`;
  }catch(e){panel.innerHTML='<div style="padding:1rem;font-size:.7rem;color:var(--dim)">Error loading report</div>'}
};

// Simple markdown section parser
function parseMarkdownSections(md){
  const lines=md.split('\n');
  const sections=[];
  let current=null;
  for(const line of lines){
    const h1=line.match(/^#\s+(.+)/);
    const h2=line.match(/^##\s+(.+)/);
    if(h1){
      if(current)sections.push(current);
      current={level:1,text:h1[1],body:''};
    }else if(h2){
      if(current)sections.push(current);
      current={level:2,text:h2[1],body:''};
    }else{
      if(!current)current={level:0,text:'',body:''};
      current.body+=line+'\n';
    }
  }
  if(current)sections.push(current);
  return sections;
}

// Render markdown block (bullets, bold, links, plain text)
function renderMdBlock(text){
  if(!text)return '';
  return text.split('\n').map(line=>{
    line=line.trim();
    if(!line)return '';
    // Bullet points
    const bullet=line.match(/^[-*]\s+(.+)/);
    if(bullet){
      let content=bullet[1];
      content=mdInline(content);
      return `<div class="ar-bullet">• ${content}</div>`;
    }
    // Numbered list
    const num=line.match(/^\d+\.\s+(.+)/);
    if(num){
      let content=num[1];
      content=mdInline(content);
      return `<div class="ar-bullet">${content}</div>`;
    }
    // Regular paragraph
    return `<div class="ar-para">${mdInline(line)}</div>`;
  }).join('');
}

// Inline markdown: bold, links, code
function mdInline(text){
  text=esc(text);
  text=text.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  text=text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" class="ar-link">$1</a>');
  text=text.replace(/`([^`]+)`/g,'<code class="ar-code">$1</code>');
  return text;
}

window.triggerValidation=async function(id){
  try{
    await fetch(`/api/brain/artifacts/${id}/validate`,{method:'POST'});
    const btn=document.querySelector('.ba-validate-btn');
    if(btn){btn.textContent='Queued ✓';btn.disabled=true}
  }catch(e){}
};

// Load archetypes for agent dots
fetch('/api/archetypes').then(r=>r.json()).then(a=>{window._archetypes=a}).catch(()=>{});

// ══════════════════════════════════
// PREDICTIONS VIEW
// ══════════════════════════════════
async function loadPredictions(){
  const list=document.getElementById('predictions-list');
  list.innerHTML='<div class="empty-state">Generating predictions from knowledge graph...</div>';
  try{
    const res=await fetch('/api/predictions');
    const preds=await res.json();
    if(!preds.length){list.innerHTML='<div class="empty-state">No predictions yet. The brain needs more data.</div>';return}
    list.innerHTML=`<div class="pred-inner">${preds.map(p=>{
      const conf=p.confidence>=0.7?'high':p.confidence>=0.4?'medium':'low';
      const pct=Math.round(p.confidence*100);
      return `<div class="pred-card">
        <div class="pred-head"><span class="pred-confidence ${conf}">${pct}%</span><span class="pred-title">${esc(p.prediction)}</span></div>
        <div class="pred-body">${esc(p.reasoning)}</div>
        <div class="pred-entities">${(p.entities||[]).map(e=>`<span class="pred-entity">${esc(e)}</span>`).join('')}</div>
        <div class="pred-meta">Based on ${p.source_count||0} signals · ${p.created_at?new Date(p.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}):'recent'}</div>
      </div>`;
    }).join('')}</div>`;
  }catch(err){list.innerHTML='<div class="empty-state">Failed to load predictions.</div>'}
}

// ══════════════════════════════════
// GUILD CHAT
// ══════════════════════════════════
const guildMsEl=document.getElementById('ms-guild');
const guildStbEl=document.getElementById('stb-guild');
let guildSeenIds=new Set();
let guildAutoScroll=true;

guildMsEl.addEventListener('scroll',()=>{
  const atBottom=guildMsEl.scrollHeight-guildMsEl.scrollTop-guildMsEl.clientHeight<60;
  guildAutoScroll=atBottom;
  if(guildStbEl)guildStbEl.classList.toggle('show',!atBottom);
});

function addGuildEl(html){
  const w=document.createElement('div');w.innerHTML=html;
  const el=w.firstElementChild;
  if(el)guildMsEl.appendChild(el);
  if(guildAutoScroll)requestAnimationFrame(()=>{guildMsEl.scrollTop=guildMsEl.scrollHeight});
}

function renderGuildMsg(msg){
  if(guildSeenIds.has(msg.id))return;
  guildSeenIds.add(msg.id);
  const c=agColor(msg.agent_id),i=agInitial(msg.agent_id),time=fmtTime(msg.created_at);
  const tokIn=msg.tokens_in||0,tokOut=msg.tokens_out||0;
  const tokHtml=(tokIn||tokOut)?`<span class="msg-tokens">${tokIn}→${tokOut}tk</span>`:'';
  const avatarHtml=`<div class="mv" style="background:${c}">${i}</div>`;
  const toolHtml=renderToolAttach(msg.tool_data);
  addGuildEl(`<div class="msg" id="gmsg-${msg.id}"><div class="mh">${avatarHtml}<span class="mn" style="color:${c}">${esc(msg.agent_name||msg.agent_id)}</span>${tokHtml}<span class="mt">${time}</span></div><div class="mb">${esc(msg.content)}</div>${toolHtml}</div>`);
}

function renderGuildTyping(data){
  hideGuildTyping();
  const c=agColor(data.agent_id),i=agInitial(data.agent_id);
  addGuildEl(`<div class="tp guild-tp"><div class="mv" style="background:${c}">${i}</div><div class="tpd"><span></span><span></span><span></span></div><span class="tpn">${esc(data.agent_name)} composing...</span></div>`);
}
function hideGuildTyping(){guildMsEl.querySelectorAll('.guild-tp').forEach(e=>e.remove())}

async function loadGuildMessages(){
  try{
    const res=await fetch('/api/guild/messages?limit=50');if(!res.ok)return;
    const msgs=await res.json();
    if(msgs.length>0){const w=guildMsEl.querySelector('.sy');if(w)w.remove()}
    for(const msg of msgs)renderGuildMsg(msg);
  }catch(err){console.error('Guild load failed:',err)}
}

window.sendGuildMessage=function(e){
  e.preventDefault();
  const input=document.getElementById('guild-chat-input');
  const text=input.value.trim();
  if(!text||!userName)return false;
  input.value='';input.style.height='auto';
  fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:text,username:userName,channel:'guild'})}).catch(console.error);
  return false;
};

// ══════════════════════════════════
// QUESTS
// ══════════════════════════════════
let allQuests=[];
async function loadQuests(){
  try{
    const res=await fetch('/api/quests');allQuests=await res.json();
    renderQuests('proposed');
  }catch(e){document.getElementById('quests-list').innerHTML='<div class="empty-state">Failed to load quests.</div>'}
}
window.filterQuests=function(filter){
  document.querySelectorAll('#view-quests .filter-btn').forEach(b=>b.classList.toggle('active',b.textContent.toLowerCase()===filter));
  renderQuests(filter);
};
function renderQuests(filter){
  const list=document.getElementById('quests-list');
  const filtered=filter==='all'?allQuests:allQuests.filter(q=>q.status===filter);
  if(!filtered.length){list.innerHTML='<div class="empty-state">No quests '+(filter==='all'?'yet':'with status "'+filter+'"')+'.</div>';return}
  list.innerHTML=filtered.map(q=>{
    const statusCls=q.status==='completed'?'green':q.status==='active'?'accent':'dim';
    return `<div class="quest-card">
      <div class="quest-head"><span class="quest-status" style="color:var(--${statusCls})">${q.status}</span><span class="quest-priority">${q.priority}</span></div>
      <div class="quest-title">${esc(q.title)}</div>
      ${q.description?`<div class="quest-desc">${esc(q.description)}</div>`:''}
      <div class="quest-meta">
        <span>Proposed by ${esc(q.proposed_by||'Brain')}</span>
        <span>👍 ${q.votes_for} / 👎 ${q.votes_against}</span>
      </div>
    </div>`;
  }).join('');
}

// ══════════════════════════════════
// TOOLS
// ══════════════════════════════════
async function loadTools(){
  try{
    const res=await fetch('/api/tools');const tools=await res.json();
    const list=document.getElementById('tools-list');
    if(!tools.length){list.innerHTML='<div class="empty-state">No tools configured yet.</div>';return}
    list.innerHTML=tools.map(t=>`<div class="tool-card">
      <div class="tool-head"><span class="tool-name">${esc(t.name)}</span><span class="tool-toggle ${t.enabled?'on':'off'}" onclick="toggleTool(${t.id})">${t.enabled?'ON':'OFF'}</span></div>
      <div class="tool-desc">${esc(t.description||'')}</div>
      <div class="tool-type">${esc(t.type)}</div>
    </div>`).join('');
  }catch(e){document.getElementById('tools-list').innerHTML='<div class="empty-state">Failed to load.</div>'}
}
window.showAddTool=function(){
  const list=document.getElementById('tools-list');
  if(document.getElementById('add-tool-form'))return;
  list.insertAdjacentHTML('afterbegin',`<div class="tool-card" id="add-tool-form">
    <input class="settings-input" id="new-tool-name" placeholder="Tool name...">
    <textarea class="settings-textarea" id="new-tool-desc" placeholder="Description..." rows="2"></textarea>
    <div class="settings-row" style="margin-top:.4rem"><button class="settings-btn settings-btn-save" onclick="saveTool()">Save</button><button class="settings-btn" onclick="document.getElementById('add-tool-form').remove()">Cancel</button></div>
  </div>`);
};
window.saveTool=async function(){
  const name=document.getElementById('new-tool-name')?.value?.trim();
  const desc=document.getElementById('new-tool-desc')?.value?.trim();
  if(!name)return;
  await fetch('/api/tools',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:desc})});
  viewsLoaded.tools=false;loadTools();
};
window.toggleTool=async function(id){
  await fetch('/api/tools/'+id+'/toggle',{method:'POST'});
  viewsLoaded.tools=false;loadTools();
};

// ══════════════════════════════════
// SKILLS
// ══════════════════════════════════
async function loadSkills(){
  try{
    const res=await fetch('/api/skills');const skills=await res.json();
    const list=document.getElementById('skills-list');
    if(!skills.length){list.innerHTML='<div class="empty-state">No skills configured yet.</div>';return}
    list.innerHTML=skills.map(s=>`<div class="tool-card">
      <div class="tool-head"><span class="tool-name">${esc(s.name)}</span><span class="tool-toggle ${s.enabled?'on':'off'}" onclick="toggleSkill(${s.id})">${s.enabled?'ON':'OFF'}</span></div>
      <div class="tool-desc">${esc(s.description||'')}</div>
      ${s.triggers?`<div class="tool-type">Triggers: ${esc(s.triggers)}</div>`:''}
    </div>`).join('');
  }catch(e){document.getElementById('skills-list').innerHTML='<div class="empty-state">Failed to load.</div>'}
}
window.showAddSkill=function(){
  const list=document.getElementById('skills-list');
  if(document.getElementById('add-skill-form'))return;
  list.insertAdjacentHTML('afterbegin',`<div class="tool-card" id="add-skill-form">
    <input class="settings-input" id="new-skill-name" placeholder="Skill name...">
    <textarea class="settings-textarea" id="new-skill-desc" placeholder="Description..." rows="2"></textarea>
    <textarea class="settings-textarea" id="new-skill-instructions" placeholder="Instructions for agents..." rows="3"></textarea>
    <input class="settings-input" id="new-skill-triggers" placeholder="Trigger phrases (comma-separated)..." style="margin-top:.3rem">
    <div class="settings-row" style="margin-top:.4rem"><button class="settings-btn settings-btn-save" onclick="saveSkill()">Save</button><button class="settings-btn" onclick="document.getElementById('add-skill-form').remove()">Cancel</button></div>
  </div>`);
};
window.saveSkill=async function(){
  const name=document.getElementById('new-skill-name')?.value?.trim();
  const desc=document.getElementById('new-skill-desc')?.value?.trim();
  const instructions=document.getElementById('new-skill-instructions')?.value?.trim();
  const triggers=document.getElementById('new-skill-triggers')?.value?.trim();
  if(!name)return;
  await fetch('/api/skills',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,description:desc,instructions,triggers})});
  viewsLoaded.skills=false;loadSkills();
};
window.toggleSkill=async function(id){
  await fetch('/api/skills/'+id+'/toggle',{method:'POST'});
  viewsLoaded.skills=false;loadSkills();
};

// ══════════════════════════════════
// SETTINGS
// ══════════════════════════════════
function loadSettings(){
  // Theme buttons
  const theme=localStorage.getItem('og-theme')||'dark';
  document.querySelectorAll('[data-theme-pick]').forEach(b=>b.classList.toggle('active',b.dataset.themePick===theme));
  // Accent
  const accent=localStorage.getItem('og-accent')||'#c8a44e';
  document.querySelectorAll('#accent-swatches .swatch').forEach(s=>s.classList.toggle('active',s.dataset.accent===accent));
  // Radius
  const radius=localStorage.getItem('og-radius')||'default';
  document.querySelectorAll('[data-radius]').forEach(b=>b.classList.toggle('active',b.dataset.radius===radius));
  // Font size
  const fs=localStorage.getItem('og-fontsize')||'default';
  document.querySelectorAll('[data-fontsize]').forEach(b=>b.classList.toggle('active',b.dataset.fontsize===fs));
  // Chat width
  const cw=localStorage.getItem('og-chatwidth')||'default';
  document.querySelectorAll('[data-chatwidth]').forEach(b=>b.classList.toggle('active',b.dataset.chatwidth===cw));
}

window.applyTheme=function(t){
  document.documentElement.setAttribute('data-theme',t);
  localStorage.setItem('og-theme',t);
  document.querySelectorAll('[data-theme-pick]').forEach(b=>b.classList.toggle('active',b.dataset.themePick===t));
  const dark=document.getElementById('theme-icon-dark');
  const light=document.getElementById('theme-icon-light');
  if(dark&&light){dark.style.display=t==='light'?'none':'';light.style.display=t==='light'?'':'none'}
};

window.setAccent=function(color){
  document.documentElement.style.setProperty('--accent',color);
  // derive accent-dim
  const r=parseInt(color.slice(1,3),16),g=parseInt(color.slice(3,5),16),b=parseInt(color.slice(5,7),16);
  document.documentElement.style.setProperty('--accent-dim',`rgba(${r},${g},${b},.06)`);
  document.documentElement.style.setProperty('--accent2',color);
  localStorage.setItem('og-accent',color);
  document.querySelectorAll('#accent-swatches .swatch').forEach(s=>s.classList.toggle('active',s.dataset.accent===color));
};

window.setRadius=function(r){
  document.documentElement.setAttribute('data-radius',r);
  localStorage.setItem('og-radius',r);
  document.querySelectorAll('[data-radius]').forEach(b=>b.classList.toggle('active',b.dataset.radius===r));
};

window.setFontSize=function(s){
  document.documentElement.setAttribute('data-fontsize',s);
  localStorage.setItem('og-fontsize',s);
  document.querySelectorAll('[data-fontsize]').forEach(b=>b.classList.toggle('active',b.dataset.fontsize===s));
};

window.setChatWidth=function(w){
  document.documentElement.setAttribute('data-chatwidth',w);
  localStorage.setItem('og-chatwidth',w);
  document.querySelectorAll('[data-chatwidth]').forEach(b=>b.classList.toggle('active',b.dataset.chatwidth===w));
};

window.resetSettings=function(){
  ['og-accent','og-radius','og-fontsize','og-chatwidth'].forEach(k=>localStorage.removeItem(k));
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--accent-dim');
  document.documentElement.style.removeProperty('--accent2');
  document.documentElement.removeAttribute('data-radius');
  document.documentElement.removeAttribute('data-fontsize');
  document.documentElement.removeAttribute('data-chatwidth');
  loadSettings();
};

// Restore settings on boot
(function(){
  const accent=localStorage.getItem('og-accent');
  if(accent)window.setAccent(accent);
  const radius=localStorage.getItem('og-radius');
  if(radius)document.documentElement.setAttribute('data-radius',radius);
  const fs=localStorage.getItem('og-fontsize');
  if(fs)document.documentElement.setAttribute('data-fontsize',fs);
  const cw=localStorage.getItem('og-chatwidth');
  if(cw)document.documentElement.setAttribute('data-chatwidth',cw);
})();

// ══════════════════════════════════
// PROFILE
// ══════════════════════════════════
function loadProfile(){
  const p=JSON.parse(localStorage.getItem('og-profile')||'{}');
  const un=document.getElementById('profile-username');
  const tt=document.getElementById('profile-title');
  const bio=document.getElementById('profile-bio');
  if(un)un.value=p.username||localStorage.getItem('og-username')||'';
  if(tt)tt.value=p.title||'';
  if(bio)bio.value=p.bio||'';
  // Avatar color
  const ac=p.avatarColor||'#c8a44e';
  document.querySelectorAll('#avatar-swatches .swatch').forEach(s=>s.classList.toggle('active',s.dataset.avatar===ac));
  // Stats
  const msgs=document.getElementById('stat-msgs');
  const joined=document.getElementById('stat-joined');
  if(msgs)msgs.textContent=p.msgCount||'0';
  if(joined)joined.textContent=p.joined||new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
}

window.setAvatarColor=function(color){
  document.querySelectorAll('#avatar-swatches .swatch').forEach(s=>s.classList.toggle('active',s.dataset.avatar===color));
};

window.saveProfile=function(){
  const un=document.getElementById('profile-username')?.value?.trim()||'';
  const tt=document.getElementById('profile-title')?.value?.trim()||'';
  const bio=document.getElementById('profile-bio')?.value?.trim()||'';
  const ac=document.querySelector('#avatar-swatches .swatch.active')?.dataset?.avatar||'#c8a44e';
  const existing=JSON.parse(localStorage.getItem('og-profile')||'{}');
  const profile={...existing,username:un,title:tt,bio:bio,avatarColor:ac,joined:existing.joined||new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})};
  localStorage.setItem('og-profile',JSON.stringify(profile));
  if(un)localStorage.setItem('og-username',un);
  userName=un;
  // visual feedback
  const btn=document.querySelector('#view-profile .settings-btn');
  if(btn){const orig=btn.textContent;btn.textContent='✓ Saved';btn.style.borderColor='var(--green)';btn.style.color='var(--green)';setTimeout(()=>{btn.textContent=orig;btn.style.borderColor='';btn.style.color=''},1500)}
};

// ── User chat ──
let userName=localStorage.getItem('og-username')||'';
window.sendMessage=function(e){
  e.preventDefault();
  const input=document.getElementById('chat-input');
  const text=input.value.trim();
  if(!text)return false;

  if(!userName){
    userName=text.slice(0,30);
    localStorage.setItem('og-username',userName);
    input.value='';
    input.style.height='auto';
    input.placeholder=`${userName}, say something...`;
    addEl(`<div class="sy">Welcome, <b>${esc(userName)}</b>. The Guild is listening.</div>`);
    return false;
  }

  input.value='';
  input.style.height='auto';
  input.disabled=true;

  fetch('/api/messages',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({content:text,username:userName})
  }).then(r=>{
    input.disabled=false;input.focus();
    if(!r.ok)console.error('Send failed');
  }).catch(err=>{
    input.disabled=false;input.focus();
    console.error('Send error:',err);
  });
  return false;
};

// Textarea auto-resize + Enter to send
(function(){
  const inp=document.getElementById('chat-input');
  if(!inp)return;
  if(userName)inp.placeholder=`${userName}, say something...`;

  inp.addEventListener('input',()=>{
    inp.style.height='auto';
    inp.style.height=Math.min(inp.scrollHeight,120)+'px';
  });

  inp.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      document.getElementById('chat-form').dispatchEvent(new Event('submit',{cancelable:true}));
    }
  });
})();

// Guild textarea auto-resize + Enter to send
(function(){
  const inp=document.getElementById('guild-chat-input');
  if(!inp)return;
  if(userName)inp.placeholder=`${userName}, say something...`;
  inp.addEventListener('input',()=>{inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,120)+'px'});
  inp.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('guild-chat-form').dispatchEvent(new Event('submit',{cancelable:true}))}
  });
})();

// ── Boot ──
loadMessages().then(()=>connectSSE());
viewsLoaded.world=true;

})();
