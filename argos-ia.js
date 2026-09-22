/* ============================================================
   A.R.G.O.S. · IA  —  Asistente integrado para SIC ARGOS
   Widget flotante con IA (Groq via proxy seguro) + acceso a las
   fichas de Firebase (personas, vehículos, extorsivos, biblioteca).

   INSTALACION:
     1) Sube este archivo a tu repo (junto a index.html).
     2) Edita CONFIG.PROXY_URL con la URL de tu Cloudflare Worker.
     3) Agrega antes de </body> en index.html:
          <script src="./argos-ia.js"></script>
   ============================================================ */
(function () {
  'use strict';

  /* ====== CONFIGURACION (EDITA ESTO) ====== */
  const CONFIG = {
    PROXY_URL: 'https://argos-ia.tkautliz.workers.dev', // <-- URL de tu Worker
    MODEL: 'openai/gpt-oss-20b',
    MAX_HISTORY: 12,
    USER: 'Investigador',
  };

  const C = { navy:'#0b2545', navy2:'#13315c', gold:'#c9a227', cyan:'#00e5ff', txt:'#e8eef5' };

  let history = [];
  let statsCache = null;
  let panelOpen = false;
  let busy = false;

  /* ====== UTILIDADES ====== */
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function md(t){var h=esc(t);h=h.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');h=h.replace(/`([^`]+)`/g,'<code>$1</code>');h=h.replace(/\n/g,'<br>');return h;}
  function norm(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
  function getDb(){try{if(window.firebase&&firebase.database)return firebase.database();}catch(e){}try{return db;}catch(e){return null;}}
  async function node(path){var d=getDb();if(!d)return{};var s=await d.ref(path).once('value');return s.val()||{};}

  /* ====== ACCESO A DATOS (Firebase) ====== */
  async function getStats(){
    if(statsCache && Date.now()-statsCache.t<60000) return statsCache;
    var arr=await Promise.all([node('fichasSIC'),node('fichasVehiculos'),node('numerosExtorsivos'),node('bibliotecaDocumentos')]);
    statsCache={t:Date.now(),
      personas:Object.keys(arr[0]).length, vehiculos:Object.keys(arr[1]).length,
      extorsivos:Object.keys(arr[2]).length, documentos:Object.keys(arr[3]).length,
      p:arr[0], v:arr[1], e:arr[2], b:arr[3]};
    return statsCache;
  }

  function nombrePersona(f){return [f.g_pnombre,f.g_snombre,f.g_papellido,f.g_sapellido].filter(Boolean).join(' ')||'(sin nombre)';}

  function resumenPersona(f){
    var org=[f.crim_org,f.crim_clica,f.crim_rango].filter(Boolean).join(' / ');
    var lugar=[f.crim_lugar_muni,f.crim_lugar_depto].filter(Boolean).join(', ');
    return [
      'Nombre: '+nombrePersona(f),
      f.g_apodo?('Alias: '+f.g_apodo):'',
      f.g_dpi?('DPI: '+f.g_dpi):'',
      f.g_sexo?('Sexo: '+f.g_sexo):'',
      org?('Estructura: '+org):'',
      f.crim_estatus?('Estatus: '+f.crim_estatus):'',
      f.crim_act?('Actividad: '+f.crim_act):'',
      lugar?('Zona de operacion: '+lugar):'',
      (f.crim_penales||f.crim_policiales)?('Antecedentes: '+[f.crim_penales?'penales':'',f.crim_policiales?'policiales':''].filter(Boolean).join(', ')):''
    ].filter(Boolean).join(' | ');
  }
  function resumenVehiculo(v){
    return ['Placa: '+(v.v_placa||v.placa||'?'),
      [v.v_marca||v.marca, v.v_linea, v.v_modelo].filter(Boolean).join(' '),
      (v.v_color||v.color)?('Color: '+(v.v_color||v.color)):'',
      (v.v_tipo||v.tipo)?('Tipo: '+(v.v_tipo||v.tipo)):'',
      v.p_nombre?('Propietario: '+v.p_nombre):'',
      v.p_dpi?('DPI prop.: '+v.p_dpi):''
    ].filter(Boolean).join(' | ');
  }
  function resumenExtorsivo(e){
    return ['Telefono: '+(e.telefonoExtorsionista||'?'),
      e.casoNo?('Caso: '+e.casoNo):'',
      e.orgCriminalAtribuye?('Atribuido a: '+e.orgCriminalAtribuye):'',
      e.montoRequerido?('Monto requerido: '+e.montoRequerido):'',
      (e.estado||e.estadoCaso)?('Estado: '+(e.estado||e.estadoCaso)):''
    ].filter(Boolean).join(' | ');
  }

  async function recuperarContexto(q){
    var st=await getStats();
    var nq=norm(q);
    var partes=['ESTADISTICAS ACTUALES: '+st.personas+' fichas de personas, '+st.vehiculos+' vehiculos, '+st.extorsivos+' numeros extorsivos, '+st.documentos+' documentos en biblioteca.'];
    var tokens=nq.split(/\s+/).filter(function(w){return w.length>2;});
    var digits=(q.match(/\d{7,}/g)||[]);
    var i,res,hay;

    if(/(persona|ficha|busca|buscar|quien|qui\u00e9n|alias|apodo|dpi|nombre|sujeto|individuo)/.test(nq)){
      res=[];
      for(var k in st.p){var f=st.p[k];hay=norm(nombrePersona(f)+' '+(f.g_apodo||'')+' '+(f.g_dpi||''));
        if(tokens.some(function(t){return hay.indexOf(t)>=0;})){res.push(f);if(res.length>=6)break;}}
      if(res.length) partes.push('PERSONAS ENCONTRADAS:\n'+res.map(function(r){return '- '+resumenPersona(r);}).join('\n'));
    }
    if(/(vehic|veh\u00edculo|carro|moto|placa|automovil|autom\u00f3vil|camioneta|pick)/.test(nq)){
      res=[];
      for(var k2 in st.v){var v=st.v[k2];hay=norm((v.v_placa||v.placa||'')+' '+(v.v_marca||v.marca||'')+' '+(v.v_linea||'')+' '+(v.p_nombre||''));
        if(tokens.some(function(t){return hay.indexOf(t)>=0;})){res.push(v);if(res.length>=6)break;}}
      if(res.length) partes.push('VEHICULOS ENCONTRADOS:\n'+res.map(function(r){return '- '+resumenVehiculo(r);}).join('\n'));
    }
    if(digits.length || /(extorsi|tel\u00e9fono|telefono|numero|n\u00famero|caso)/.test(nq)){
      res=[];
      for(var k3 in st.e){var ex=st.e[k3];var tel=String(ex.telefonoExtorsionista||'');hay=norm(tel+' '+(ex.casoNo||'')+' '+(ex.orgCriminalAtribuye||''));
        if(digits.some(function(d){return tel.indexOf(d)>=0;})||tokens.some(function(t){return hay.indexOf(t)>=0;})){res.push(ex);if(res.length>=8)break;}}
      if(res.length) partes.push('NUMEROS EXTORSIVOS ENCONTRADOS:\n'+res.map(function(r){return '- '+resumenExtorsivo(r);}).join('\n'));
    }
    return partes.join('\n\n');
  }
  /* ====== LLAMADA A LA IA (via proxy seguro) ====== */
  async function consultarIA(userText, contexto){
    var sys={role:'system',content:
      'Eres ARGOS, el asistente de inteligencia artificial del Sistema de Informacion Criminal (SIC ARGOS). '
      +'Te diriges a '+CONFIG.USER+'. Respondes SIEMPRE en espanol, de forma profesional, clara y concisa. '
      +'Usa EXCLUSIVAMENTE la informacion del CONTEXTO para hablar de fichas, vehiculos, numeros extorsivos o estadisticas; '
      +'si el contexto no contiene el dato, dilo claramente y NO inventes. '
      +'Para redacciones (informes, oficios) entrega el texto final listo para usar.\n\nCONTEXTO:\n'+contexto};
    var msgs=[sys].concat(history.slice(-CONFIG.MAX_HISTORY),[{role:'user',content:userText}]);
    var r=await fetch(CONFIG.PROXY_URL,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:CONFIG.MODEL,messages:msgs,max_tokens:600})});
    if(!r.ok) throw new Error('el proxy respondio HTTP '+r.status);
    var data=await r.json();
    var reply=(data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content||'').trim();
    if(!reply) throw new Error(data.error?(data.error.message||JSON.stringify(data.error)):'respuesta vacia');
    history.push({role:'user',content:userText});
    history.push({role:'assistant',content:reply});
    if(history.length>CONFIG.MAX_HISTORY*2) history=history.slice(-CONFIG.MAX_HISTORY*2);
    return reply;
  }

  /* ====== GENERACION DE IMAGENES (Pollinations, gratis) ====== */
  function generarImagen(desc){
    var clean=desc.replace(/^(genera|crea|dibuja|haz|hazme)\s+(una\s+)?(imagen|foto|dibujo|retrato)\s+(de\s+)?/i,'').trim()||desc;
    var url='https://image.pollinations.ai/prompt/'+encodeURIComponent(clean)+'?width=768&height=768&nologo=true';
    return {url:url, clean:clean};
  }

  /* ====== MENSAJES EN LA INTERFAZ ====== */
  function addMsg(who, htmlOrNode){
    var wrap=document.getElementById('aia-msgs');
    var row=document.createElement('div'); row.className='aia-row aia-'+who;
    var bub=document.createElement('div'); bub.className='aia-bub';
    if(typeof htmlOrNode==='string') bub.innerHTML=htmlOrNode; else if(htmlOrNode) bub.appendChild(htmlOrNode);
    row.appendChild(bub); wrap.appendChild(row); wrap.scrollTop=wrap.scrollHeight;
    return bub;
  }

  async function enviar(){
    if(busy) return;
    var inp=document.getElementById('aia-input');
    var text=inp.value.trim(); if(!text) return;
    inp.value=''; inp.style.height='auto';
    addMsg('user', esc(text));
    busy=true; setEstado('procesando');

    // Comando de imagen
    if(/(genera|crea|dibuja|haz|hazme)\b[\s\S]*?(imagen|foto|dibujo|retrato)/i.test(text)){
      var pend=addMsg('bot','Generando imagen...');
      var info=generarImagen(text);
      var img=new Image(); img.className='aia-img'; img.alt=info.clean; img.src=info.url;
      img.onload=function(){pend.innerHTML=''; pend.appendChild(img);
        var a=document.createElement('a'); a.href=info.url; a.target='_blank'; a.rel='noopener';
        a.textContent='Abrir / descargar imagen'; a.className='aia-link'; pend.appendChild(a); finalizar();};
      img.onerror=function(){pend.textContent='No pude generar la imagen (revisa tu conexion).'; finalizar();};
      return;
    }

    // Consulta a la IA con contexto de la base de datos
    var pend2=addMsg('bot',''); pend2.appendChild(loader());
    try{
      var ctx=await recuperarContexto(text);
      var reply=await consultarIA(text, ctx);
      pend2.innerHTML=md(reply);
    }catch(e){
      pend2.textContent='\u26a0\ufe0f Error: '+e.message+'. Verifica la URL del proxy (CONFIG.PROXY_URL) o tu conexion.';
    }
    finalizar();

    function finalizar(){busy=false; setEstado(''); var w=document.getElementById('aia-msgs'); w.scrollTop=w.scrollHeight;}
  }
  /* ====== CONSTRUCCION DE LA INTERFAZ ====== */
  function buildUI(){
    var css=''
    +'#aia-fab{position:fixed;right:22px;bottom:22px;width:60px;height:60px;border-radius:50%;'
    +'background:linear-gradient(135deg,'+C.navy+','+C.navy2+');color:'+C.gold+';border:2px solid '+C.gold+';'
    +'box-shadow:0 6px 22px rgba(0,0,0,.4);cursor:pointer;z-index:99980;display:flex;align-items:center;'
    +'justify-content:center;font-size:26px;transition:transform .2s}'
    +'#aia-fab:hover{transform:scale(1.08)}'
    +'#aia-panel{position:fixed;right:22px;bottom:94px;width:372px;max-width:calc(100vw - 24px);'
    +'height:544px;max-height:calc(100vh - 120px);background:#04070f;border:1px solid '+C.navy2+';'
    +'border-radius:16px;box-shadow:0 12px 44px rgba(0,0,0,.55);z-index:99981;display:none;'
    +'flex-direction:column;overflow:hidden;font-family:Inter,Segoe UI,Arial,sans-serif}'
    +'#aia-panel.open{display:flex}'
    +'.aia-head{background:linear-gradient(135deg,'+C.navy+','+C.navy2+');padding:12px 16px;display:flex;'
    +'align-items:center;gap:10px;border-bottom:2px solid '+C.gold+'}'
    +'.aia-head .t{color:#fff;font-weight:700;font-size:15px;letter-spacing:.5px}'
    +'.aia-head .s{color:'+C.cyan+';font-size:10px}'
    +'.aia-x{margin-left:auto;background:none;border:none;color:#9fb3c8;font-size:18px;cursor:pointer}'
    +'#aia-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}'
    +'.aia-row{display:flex}.aia-row.aia-user{justify-content:flex-end}'
    +'.aia-bub{max-width:82%;padding:9px 12px;border-radius:12px;font-size:13px;line-height:1.45;color:'+C.txt+';word-wrap:break-word;overflow-wrap:anywhere}'
    +'.aia-bot .aia-bub{background:#0a1626;border:1px solid '+C.navy2+';border-top-left-radius:3px}'
    +'.aia-user .aia-bub{background:linear-gradient(135deg,'+C.navy2+','+C.navy+');color:#fff;border-top-right-radius:3px}'
    +'.aia-bub code{background:#02060d;padding:1px 5px;border-radius:4px;color:'+C.cyan+';font-size:12px}'
    +'.aia-img{width:100%;border-radius:8px;margin:2px 0}'
    +'.aia-link{display:inline-block;margin-top:6px;color:'+C.cyan+';font-size:12px}'
    +'.aia-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 8px}'
    +'.aia-chip{background:#0a1626;border:1px solid '+C.navy2+';color:'+C.cyan+';border-radius:14px;padding:5px 10px;font-size:11px;cursor:pointer}'
    +'.aia-chip:hover{border-color:'+C.gold+';color:'+C.gold+'}'
    +'.aia-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid '+C.navy2+';background:#070d1a}'
    +'#aia-input{flex:1;background:#02060d;border:1px solid '+C.navy2+';border-radius:10px;color:'+C.txt+';padding:10px 12px;font-size:13px;outline:none;resize:none;font-family:inherit;max-height:80px}'
    +'#aia-input:focus{border-color:'+C.cyan+'}'
    +'#aia-send{background:'+C.navy2+';border:1px solid '+C.gold+';color:'+C.gold+';border-radius:10px;width:44px;font-size:18px;cursor:pointer}'
    +'#aia-send:hover{background:'+C.gold+';color:'+C.navy+'}'
    +'.aia-dots span{display:inline-block;width:6px;height:6px;margin:0 2px;border-radius:50%;background:'+C.cyan+';animation:aiabl 1s infinite}'
    +'.aia-dots span:nth-child(2){animation-delay:.2s}.aia-dots span:nth-child(3){animation-delay:.4s}'
    +'@keyframes aiabl{0%,60%,100%{opacity:.25}30%{opacity:1}}'
    +'@media(max-width:480px){#aia-panel{right:8px;left:8px;width:auto;bottom:84px}}';
    var st=document.createElement('style'); st.textContent=css; document.head.appendChild(st);

    var fab=document.createElement('button'); fab.id='aia-fab'; fab.type='button';
    fab.title='Asistente IA ARGOS'; fab.textContent='\ud83e\udd16';
    fab.addEventListener('click', toggle); document.body.appendChild(fab);

    var panel=document.createElement('div'); panel.id='aia-panel';
    panel.innerHTML=
      '<div class="aia-head"><div><div class="t">A.R.G.O.S \u00b7 IA</div><div class="s" id="aia-status">Asistente en linea</div></div>'
      +'<button class="aia-x" type="button" title="Cerrar">\u2715</button></div>'
      +'<div id="aia-msgs"></div>'
      +'<div class="aia-chips">'
      +'<span class="aia-chip" data-q="\u00bfCuantas fichas hay registradas en el sistema?">\u00bfCuantas fichas hay?</span>'
      +'<span class="aia-chip" data-q="Buscar persona: ">Buscar persona</span>'
      +'<span class="aia-chip" data-q="Buscar vehiculo con placa ">Buscar por placa</span>'
      +'<span class="aia-chip" data-q="Redacta un oficio formal sobre ">Redactar oficio</span>'
      +'</div>'
      +'<div class="aia-foot"><textarea id="aia-input" rows="1" placeholder="Escribe tu consulta..."></textarea>'
      +'<button id="aia-send" type="button" title="Enviar">\u27a4</button></div>';
    document.body.appendChild(panel);

    panel.querySelector('.aia-x').addEventListener('click', toggle);
    document.getElementById('aia-send').addEventListener('click', enviar);
    var inp=document.getElementById('aia-input');
    inp.addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); enviar(); }});
    inp.addEventListener('input', function(){ inp.style.height='auto'; inp.style.height=Math.min(inp.scrollHeight,80)+'px'; });
    var chips=panel.querySelectorAll('.aia-chip');
    for(var i=0;i<chips.length;i++){ (function(ch){ ch.addEventListener('click', function(){
      var q=ch.getAttribute('data-q'); inp.value=q; inp.focus();
      if(q.indexOf('Cuantas')>=0) enviar();
    }); })(chips[i]); }
  }

  function toggle(){
    panelOpen=!panelOpen;
    document.getElementById('aia-panel').classList.toggle('open', panelOpen);
    if(panelOpen && !document.getElementById('aia-msgs').children.length){
      addMsg('bot','Hola '+esc(CONFIG.USER)+'. Soy <strong>ARGOS</strong>, tu asistente del Sistema de Informacion Criminal. Puedo consultar fichas de personas, vehiculos y numeros extorsivos, darte estadisticas, redactar textos y generar imagenes. \u00bfEn que te ayudo?');
      getStats().catch(function(){});
    }
    if(panelOpen) setTimeout(function(){ var i=document.getElementById('aia-input'); if(i) i.focus(); }, 100);
  }

  function setEstado(s){ var el=document.getElementById('aia-status'); if(el) el.textContent = s==='procesando' ? 'Procesando...' : 'Asistente en linea'; }
  function loader(){ var d=document.createElement('span'); d.className='aia-dots'; d.innerHTML='<span></span><span></span><span></span>'; return d; }

  function init(){
    if(!CONFIG.PROXY_URL || CONFIG.PROXY_URL.indexOf('TU-WORKER')>=0)
      console.warn('[ARGOS IA] Configura CONFIG.PROXY_URL con la URL de tu Cloudflare Worker.');
    buildUI();
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
