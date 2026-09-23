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
    // Datos de SOPORTE mostrados cuando el usuario NO ha iniciado sesion:
    SOPORTE: {
      nombre: 'Soporte ARGOS',
      // TU numero de WhatsApp: codigo de pais + numero, SOLO digitos.
      // Ej. Guatemala: '50240702190'. Mientras diga 00000000 no se mostrara el boton.
      whatsapp: '50240702190',
      mensaje: 'Hola, necesito ayuda con el sistema ARGOS.',
    },
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

  /* ====== ESTADO DE SESION ====== */
  function estaLogueado(){
    try{ if(window.firebase && firebase.auth && firebase.auth().currentUser) return true; }catch(e){}
    var appScr=document.getElementById('app-screen');
    if(appScr && !appScr.classList.contains('oculto')) return true;
    try{ if(window.usuarioSesionActual) return true; }catch(e){}
    return false;
  }
  function waHref(){ var n=String(CONFIG.SOPORTE.whatsapp||'').replace(/\D/g,''); return 'https://wa.me/'+n+'?text='+encodeURIComponent(CONFIG.SOPORTE.mensaje||''); }
  function tieneWhatsApp(){ var n=String(CONFIG.SOPORTE.whatsapp||''); return n.replace(/\D/g,'').length>=8 && n.indexOf('00000000')<0; }

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
  async function consultarIA(userText, systemContent){
    var sys={role:'system',content: systemContent};
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
  // opts.hd -> genera en alta resolucion (mas grande + mejora + modelo flux)
  // opts.seed -> reutiliza la misma semilla para obtener LA MISMA imagen en HD
  function generarImagen(desc, opts){
    opts = opts || {};
    var clean=desc.replace(/^(genera|crea|dibuja|haz|hazme)\s+(una\s+)?(imagen|foto|dibujo|retrato)\s+(de\s+)?/i,'').trim()||desc;
    var hd = !!opts.hd;
    var seed = (opts.seed!=null) ? opts.seed : Math.floor(Math.random()*1e9);
    var w = hd ? 1280 : 768;
    var h = hd ? 1280 : 768;
    var params = 'width='+w+'&height='+h+'&nologo=true&seed='+seed;
    if(hd) params += '&enhance=true&model=flux'; // mayor detalle/calidad
    var url='https://image.pollinations.ai/prompt/'+encodeURIComponent(clean)+'?'+params;
    return {url:url, clean:clean, seed:seed, hd:hd};
  }

  // Pinta una imagen generada dentro de 'cont'. Si no es HD, agrega el boton
  // "Convertir a alta resolucion" que la regenera mas grande con la misma semilla.
  function pintarImagen(cont, info, originalText, onReady){
    cont.innerHTML='';
    cont.appendChild(loader());
    var img=new Image(); img.className='aia-img'; img.alt=info.clean; img.src=info.url;
    img.onload=function(){
      cont.innerHTML='';
      cont.appendChild(img);
      var a=document.createElement('a'); a.href=info.url; a.target='_blank'; a.rel='noopener';
      a.className='aia-link'; a.textContent = info.hd ? 'Abrir / descargar (alta resolucion)' : 'Abrir / descargar imagen';
      cont.appendChild(a);
      if(!info.hd){
        var btn=document.createElement('button'); btn.type='button'; btn.className='aia-hd';
        btn.textContent='\ud83d\udd0d Convertir a alta resolucion';
        btn.addEventListener('click', function(){
          if(busy) return;
          btn.disabled=true; btn.textContent='Mejorando a alta resolucion...';
          var hdInfo=generarImagen(originalText, {hd:true, seed:info.seed});
          var cont2=addMsg('bot','');
          pintarImagen(cont2, hdInfo, originalText, null);
        });
        cont.appendChild(document.createElement('br'));
        cont.appendChild(btn);
      }
      var w=document.getElementById('aia-msgs'); if(w) w.scrollTop=w.scrollHeight;
      if(onReady) onReady();
    };
    img.onerror=function(){
      cont.textContent='No pude generar la imagen (revisa tu conexion).';
      if(onReady) onReady();
    };
  }

  /* ====== MEJORAR (SUPER-RESOLUCION) DE FOTOS SUBIDAS ====== */
  // Permite subir una foto propia y aumentarle la resolucion. Intenta
  // super-resolucion con IA (UpscalerJS/TensorFlow.js, 100% en el navegador);
  // si no puede cargarse, usa una ampliacion + afinado con canvas como respaldo.
  function fileToDataUrl(file){
    return new Promise(function(res,rej){
      var r=new FileReader();
      r.onload=function(){res(r.result);};
      r.onerror=function(){rej(new Error('no se pudo leer el archivo'));};
      r.readAsDataURL(file);
    });
  }
  function loadImg(src){
    return new Promise(function(res,rej){
      var i=new Image();
      i.onload=function(){res(i);};
      i.onerror=function(){rej(new Error('imagen invalida'));};
      i.src=src;
    });
  }
  function loadScript(src){
    return new Promise(function(res,rej){
      var s=document.createElement('script'); s.src=src; s.async=true;
      s.onload=function(){res();};
      s.onerror=function(){rej(new Error('no se pudo cargar recurso'));};
      document.head.appendChild(s);
    });
  }
  var _upscaler=null, _upLoading=null;
  function ensureUpscaler(){
    if(_upscaler) return Promise.resolve(_upscaler);
    if(_upLoading) return _upLoading;
    _upLoading=(async function(){
      // 1) TensorFlow.js  2) modelo por defecto (ESRGAN)  3) motor UpscalerJS
      if(!window.tf) await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
      if(!window.DefaultUpscalerJSModel) await loadScript('https://cdn.jsdelivr.net/npm/@upscalerjs/default-model@1.0.0/dist/umd/index.min.js');
      if(!window.Upscaler) await loadScript('https://cdn.jsdelivr.net/npm/upscaler@1.0.0/dist/browser/umd/upscaler.min.js');
      var U = window.Upscaler && (window.Upscaler.default || window.Upscaler);
      var M = window.DefaultUpscalerJSModel && (window.DefaultUpscalerJSModel.default || window.DefaultUpscalerJSModel);
      if(typeof U!=='function') throw new Error('motor IA no disponible');
      if(!M) throw new Error('modelo IA no disponible');
      _upscaler=new U({ model: M });
      return _upscaler;
    })();
    _upLoading.catch(function(){ _upLoading=null; }); // permite reintentar si fallo la carga
    return _upLoading;
  }
  // Ampliacion clasica (respaldo): escala con suavizado de alta calidad y aplica
  // un ligero enfoque (unsharp) para que se vea mas nitida.
  function canvasUpscale(img, factor){
    factor=factor||2;
    var w=img.naturalWidth||img.width, h=img.naturalHeight||img.height;
    var maxDim=2400, scale=factor;
    if(w*scale>maxDim || h*scale>maxDim){ scale=Math.min(maxDim/w, maxDim/h); if(scale<1) scale=1; }
    var tw=Math.max(1,Math.round(w*scale)), th=Math.max(1,Math.round(h*scale));
    var c=document.createElement('canvas'); c.width=tw; c.height=th;
    var ctx=c.getContext('2d');
    ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(img,0,0,tw,th);
    try{ sharpen(ctx,tw,th,0.5); }catch(e){}
    return c.toDataURL('image/png');
  }
  function sharpen(ctx,w,h,amount){
    var src=ctx.getImageData(0,0,w,h), out=ctx.createImageData(w,h);
    var s=src.data, o=out.data;
    var k=[0,-1,0,-1,5,-1,0,-1,0];
    for(var y=0;y<h;y++){
      for(var x=0;x<w;x++){
        var i=(y*w+x)*4;
        for(var ch=0;ch<3;ch++){
          var sum=0, ki=0;
          for(var ky=-1;ky<=1;ky++){
            for(var kx=-1;kx<=1;kx++){
              var yy=y+ky; if(yy<0)yy=0; else if(yy>=h)yy=h-1;
              var xx=x+kx; if(xx<0)xx=0; else if(xx>=w)xx=w-1;
              sum+=s[(yy*w+xx)*4+ch]*k[ki++];
            }
          }
          var val=s[i+ch]*(1-amount)+sum*amount;
          o[i+ch]=val<0?0:val>255?255:val;
        }
        o[i+3]=s[i+3];
      }
    }
    ctx.putImageData(out,0,0);
  }
  async function mejorarFoto(file, cont){
    cont.innerHTML='';
    var estado=document.createElement('div'); estado.textContent='Analizando la imagen...';
    cont.appendChild(estado); cont.appendChild(loader());
    var dataUrl=await fileToDataUrl(file);
    var img=await loadImg(dataUrl);
    var salida, metodo, mp=img.naturalWidth*img.naturalHeight;
    try{
      if(mp>4000000) throw new Error('imagen muy grande');
      estado.textContent='Aplicando super-resolucion con IA (la primera vez puede tardar unos segundos)...';
      var up=await ensureUpscaler();
      salida=await up.upscale(img, {patchSize:64, padding:4});
      metodo='ia';
    }catch(e){
      estado.textContent='Ampliando y afinando la imagen...';
      salida=canvasUpscale(img,2);
      metodo='canvas';
    }
    var out=await loadImg(salida);
    cont.innerHTML='';
    var r=new Image(); r.className='aia-img'; r.alt='Imagen mejorada'; r.src=salida; cont.appendChild(r);
    var cap=document.createElement('div'); cap.className='aia-cap';
    cap.textContent=(metodo==='ia' ? 'Mejorada con super-resolucion IA' : 'Ampliada y afinada')
      +' \u2014 '+out.naturalWidth+'\u00d7'+out.naturalHeight+' px (original '+img.naturalWidth+'\u00d7'+img.naturalHeight+' px).';
    cont.appendChild(cap);
    var a=document.createElement('a'); a.href=salida; a.download='argos-mejorada.png';
    a.className='aia-link'; a.textContent='Descargar imagen mejorada'; cont.appendChild(a);
    var w=document.getElementById('aia-msgs'); if(w) w.scrollTop=w.scrollHeight;
  }
  async function iniciarMejora(file){
    if(busy) return;
    if(!file || !/^image\//.test(file.type||'')){ addMsg('bot','Ese archivo no parece una imagen. Sube una foto (JPG o PNG).'); return; }
    busy=true; setEstado('procesando');
    addMsg('user','\ud83d\uddbc\ufe0f '+esc(file.name||'foto'));
    var cont=addMsg('bot','');
    try{ await mejorarFoto(file, cont); }
    catch(e){ cont.textContent='No pude procesar la imagen ('+(e&&e.message?e.message:'error')+'). Intenta con otra foto.'; }
    busy=false; setEstado('');
  }

  /* ====== SOPORTE (usuario sin sesion) ====== */
  function botonWhatsApp(){
    var a=document.createElement('a'); a.href=waHref(); a.target='_blank'; a.rel='noopener';
    a.className='aia-wa'; a.textContent='\ud83d\udcac Escribir por WhatsApp'; return a;
  }
  function accionSoporte(tipo){
    if(tipo==='whatsapp'){
      addMsg('user','Contactar por WhatsApp');
      var b=addMsg('bot', tieneWhatsApp()
        ? ('Con gusto. Escribe a <strong>'+esc(CONFIG.SOPORTE.nombre)+'</strong> por WhatsApp y te atenderemos lo antes posible:')
        : 'El contacto de WhatsApp aun no ha sido configurado por el administrador.');
      if(tieneWhatsApp()) b.appendChild(botonWhatsApp());
    } else if(tipo==='password'){
      addMsg('user','Cambiar / recuperar contrasena');
      var b2=addMsg('bot','Para cambiar o recuperar tu contrasena:<br>'
        +'1. Verifica que tu usuario este <strong>Activo</strong>.<br>'
        +'2. Por seguridad, el restablecimiento lo realiza el <strong>administrador</strong> del sistema.<br>'
        +'3. Solicitalo indicando tu nombre de usuario.');
      if(tieneWhatsApp()){ var p=document.createElement('div'); p.style.marginTop='6px'; p.textContent='Solicitalo aqui:'; b2.appendChild(p); b2.appendChild(botonWhatsApp()); }
    } else if(tipo==='login'){
      addMsg('user','\u00bfComo ingreso al sistema?');
      addMsg('bot','Para ingresar, escribe tu <strong>usuario</strong> y <strong>contrasena</strong> en la pantalla de inicio y pulsa <strong>INGRESAR</strong>. Si tu usuario no esta activo o no lo recuerdas, contacta al administrador.');
    }
    var w=document.getElementById('aia-msgs'); if(w) w.scrollTop=w.scrollHeight;
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
    var logueado=estaLogueado();

    // Comando de imagen (solo con sesion iniciada)
    if(logueado && /(gener\w*|crea\w*|dibuj\w*|ilustr\w*|haz|hazme)[\s\S]*?(im[a\u00e1]gen\w*|foto\w*|dibujo|retrato)/i.test(text)){
      var pend=addMsg('bot','');
      var info=generarImagen(text);
      pintarImagen(pend, info, text, finalizar);
      return;
    }

    var pend2=addMsg('bot',''); pend2.appendChild(loader());
    try{
      var systemContent;
      if(logueado){
        var ctx=await recuperarContexto(text);
        systemContent=
          'Eres ARGOS, el asistente de inteligencia artificial del Sistema de Informacion Criminal (SIC ARGOS). '
          +'Te diriges a '+CONFIG.USER+'. Respondes SIEMPRE en espanol, de forma profesional, clara y concisa. '
          +'Usa EXCLUSIVAMENTE la informacion del CONTEXTO para hablar de fichas, vehiculos, numeros extorsivos o estadisticas; '
          +'si el contexto no contiene el dato, dilo claramente y NO inventes. '
          +'Para redacciones (informes, oficios) entrega el texto final listo para usar.\n\nCONTEXTO:\n'+ctx;
      } else {
        systemContent=
          'Eres el asistente de SOPORTE del sistema SIC ARGOS. El usuario NO ha iniciado sesion, por lo que NO tienes acceso a fichas ni a ningun dato del sistema. '
          +'Ayuda UNICAMENTE con: como iniciar sesion, recuperar o cambiar la contrasena, problemas de acceso y datos de contacto de soporte. '
          +'Si preguntan por fichas, personas, vehiculos o numeros, responde con amabilidad que primero deben iniciar sesion con sus credenciales. '
          +'Se breve y profesional. Responde SIEMPRE en espanol.'
          +(tieneWhatsApp()?(' Contacto de soporte: '+CONFIG.SOPORTE.nombre+', WhatsApp '+String(CONFIG.SOPORTE.whatsapp).replace(/\D/g,'')+'.'):'');
      }
      var reply=await consultarIA(text, systemContent);
      pend2.innerHTML=md(reply);
      if(!logueado && tieneWhatsApp()) pend2.appendChild(botonWhatsApp());
    }catch(e){
      if(!logueado){
        pend2.innerHTML='En este momento no puedo procesar tu consulta. '+(tieneWhatsApp()?'Puedes escribirnos por WhatsApp:':'Intenta de nuevo mas tarde.');
        if(tieneWhatsApp()) pend2.appendChild(botonWhatsApp());
      } else {
        pend2.textContent='\u26a0\ufe0f Error: '+e.message+'. Verifica la conexion o vuelve a intentar.';
      }
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
    +'.aia-hd{display:inline-block;margin-top:8px;background:'+C.navy2+';border:1px solid '+C.gold+';color:'+C.gold+';border-radius:10px;padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}'
    +'.aia-hd:hover:not(:disabled){background:'+C.gold+';color:'+C.navy+'}'
    +'.aia-hd:disabled{opacity:.6;cursor:default}'
    +'.aia-wa{display:inline-block;margin-top:8px;background:#25d366;color:#04140a;font-weight:700;text-decoration:none;padding:8px 14px;border-radius:10px;font-size:12px}'
    +'.aia-wa:hover{filter:brightness(1.08)}'
    +'.aia-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 8px}'
    +'.aia-chip{background:#0a1626;border:1px solid '+C.navy2+';color:'+C.cyan+';border-radius:14px;padding:5px 10px;font-size:11px;cursor:pointer}'
    +'.aia-chip:hover{border-color:'+C.gold+';color:'+C.gold+'}'
    +'.aia-foot{display:flex;gap:8px;padding:10px 12px;border-top:1px solid '+C.navy2+';background:#070d1a}'
    +'#aia-input{flex:1;background:#02060d;border:1px solid '+C.navy2+';border-radius:10px;color:'+C.txt+';padding:10px 12px;font-size:13px;outline:none;resize:none;font-family:inherit;max-height:80px}'
    +'#aia-input:focus{border-color:'+C.cyan+'}'
    +'#aia-send{background:'+C.navy2+';border:1px solid '+C.gold+';color:'+C.gold+';border-radius:10px;width:44px;font-size:18px;cursor:pointer}'
    +'#aia-send:hover{background:'+C.gold+';color:'+C.navy+'}'
    +'#aia-upload{background:'+C.navy2+';border:1px solid '+C.cyan+';color:'+C.cyan+';border-radius:10px;width:40px;font-size:16px;cursor:pointer}'
    +'#aia-upload:hover{background:'+C.cyan+';color:'+C.navy+'}'
    +'.aia-cap{font-size:11px;color:#9fb3c8;margin-top:5px}'
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
      +'<div class="aia-chips" id="aia-chips"></div>'
      +'<div class="aia-foot">'
      +'<button id="aia-upload" type="button" title="Subir foto para mejorar su resolucion">\ud83d\udcce</button>'
      +'<input type="file" id="aia-file" accept="image/*" style="display:none">'
      +'<textarea id="aia-input" rows="1" placeholder="Escribe tu consulta..."></textarea>'
      +'<button id="aia-send" type="button" title="Enviar">\u27a4</button></div>';
    document.body.appendChild(panel);

    panel.querySelector('.aia-x').addEventListener('click', toggle);
    document.getElementById('aia-send').addEventListener('click', enviar);
    var inp=document.getElementById('aia-input');
    inp.addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); enviar(); }});
    inp.addEventListener('input', function(){ inp.style.height='auto'; inp.style.height=Math.min(inp.scrollHeight,80)+'px'; });
    var upBtn=document.getElementById('aia-upload');
    var fileInp=document.getElementById('aia-file');
    if(upBtn && fileInp){
      upBtn.addEventListener('click', function(){
        if(busy) return;
        if(!estaLogueado()){ addMsg('bot','Para mejorar una foto primero debes iniciar sesion en el sistema.'); return; }
        fileInp.value=''; fileInp.click();
      });
      fileInp.addEventListener('change', function(){
        var f=fileInp.files && fileInp.files[0]; if(f) iniciarMejora(f);
      });
    }
  }

  function renderChips(modo){
    var cont=document.getElementById('aia-chips'); if(!cont) return;
    cont.innerHTML='';
    var inp=document.getElementById('aia-input');
    var defs = modo==='soporte'
      ? [ {t:'Cambiar contrasena', action:'password'},
          {t:'\ud83d\udcac WhatsApp', action:'whatsapp'},
          {t:'\u00bfComo ingreso?', action:'login'} ]
      : [ {t:'\u00bfCuantas fichas hay?', q:'\u00bfCuantas fichas hay registradas en el sistema?', send:true},
          {t:'Buscar persona', q:'Buscar persona: '},
          {t:'Buscar por placa', q:'Buscar vehiculo con placa '},
          {t:'\ud83d\udcce Mejorar una foto', action:'upload'},
          {t:'Redactar oficio', q:'Redacta un oficio formal sobre '} ];
    defs.forEach(function(d){
      var ch=document.createElement('span'); ch.className='aia-chip'; ch.textContent=d.t;
      ch.addEventListener('click', function(){
        if(d.action==='upload'){ var fi=document.getElementById('aia-file'); if(fi){ fi.value=''; fi.click(); } return; }
        if(d.action){ accionSoporte(d.action); return; }
        inp.value=d.q; inp.focus();
        if(d.send) enviar();
      });
      cont.appendChild(ch);
    });
  }

  function toggle(){
    panelOpen=!panelOpen;
    document.getElementById('aia-panel').classList.toggle('open', panelOpen);
    if(panelOpen){
      var modo = estaLogueado() ? 'full' : 'soporte';
      renderChips(modo);
      var st=document.getElementById('aia-status');
      if(st) st.textContent = modo==='soporte' ? 'Soporte y ayuda' : 'Asistente en linea';
      if(!document.getElementById('aia-msgs').children.length){
        if(modo==='full'){
          addMsg('bot','Hola '+esc(CONFIG.USER)+'. Soy <strong>ARGOS</strong>, tu asistente del Sistema de Informacion Criminal. Puedo consultar fichas de personas, vehiculos y numeros extorsivos, darte estadisticas, redactar textos, generar imagenes y <strong>mejorar la resolucion de fotos que subas</strong> (boton \ud83d\udcce). \u00bfEn que te ayudo?');
          getStats().catch(function(){});
        } else {
          addMsg('bot','Hola \ud83d\udc4b Soy el asistente de <strong>ARGOS</strong>. Aun no has iniciado sesion, pero puedo ayudarte con el acceso al sistema. \u00bfQue necesitas?<br>\u2022 Cambiar o recuperar tu contrasena<br>\u2022 Ayuda para ingresar<br>\u2022 Contactar a soporte por WhatsApp');
        }
      }
      setTimeout(function(){ var i=document.getElementById('aia-input'); if(i) i.focus(); }, 100);
    }
  }

  function resetChat(){
    history=[]; statsCache=null;
    var w=document.getElementById('aia-msgs'); if(w) w.innerHTML='';
    if(panelOpen){ panelOpen=false; toggle(); } // reabrir para refrescar bienvenida/chips segun modo
  }

  function setEstado(s){ var el=document.getElementById('aia-status'); if(!el) return; if(s==='procesando'){ el.textContent='Procesando...'; return; } el.textContent = estaLogueado() ? 'Asistente en linea' : 'Soporte y ayuda'; }
  function loader(){ var d=document.createElement('span'); d.className='aia-dots'; d.innerHTML='<span></span><span></span><span></span>'; return d; }

  function init(){
    if(!CONFIG.PROXY_URL || CONFIG.PROXY_URL.indexOf('TU-WORKER')>=0)
      console.warn('[ARGOS IA] Configura CONFIG.PROXY_URL con la URL de tu Cloudflare Worker.');
    buildUI();
    try{
      if(window.firebase && firebase.auth){
        var prev = !!firebase.auth().currentUser;
        firebase.auth().onAuthStateChanged(function(u){
          var now=!!u; if(now!==prev){ prev=now; resetChat(); }
        });
      }
    }catch(e){}
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
