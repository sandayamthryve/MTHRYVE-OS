// Slow start, gentle acceleration, then zero-velocity landing on the same meshes.
function tonyArrivalPose(seconds, reducedMotion){
  seconds/=0.72; // 3.6-second orbit, preserving the acceleration/deceleration curve.
  const duration=5;
  const progress=reducedMotion?1:Math.min(1,Math.max(0,seconds/duration));
  const eased=progress*progress*progress*(progress*(progress*6-15)+10);
  return {offset:-Math.PI*2*(1-eased),settled:progress===1,
    labelOpacity:reducedMotion?1:Math.max(0,Math.min(1,(seconds-duration)/0.6)),
    spin:reducedMotion?0:Math.sin(progress*Math.PI)};
}
function tonyPlanetReveal(seconds,index,reducedMotion){
  seconds/=0.72;
  if(reducedMotion)return 1;
  const p=Math.max(0,Math.min(1,(seconds-0.3-index*0.13)/0.45));
  return p*p*(3-2*p);
}

/* name, agent, colour token, surface archetype, radius, ring? */
const CNODES=[
 ['Commerce','MERCHANT','--grn','terran',0.36,0],
 ['Finance','LEDGER','--grn','icegiant',0.42,0],
 ['Creative','VESPER','--gold','jovian',0.54,0],
 ['Affiliate','SCOUT','--purp','lava',0.29,0],
 ['Trend · CSI','ORACLE','--gold','martian',0.31,0],
 ['Customer Care','CARE','--teal','ocean',0.34,0],
 ['Live Selling','ANCHOR','--pink','venusian',0.32,0],
 ['Warehouse','LOGI','--blue','mercurial',0.26,0],
 ['Reporting','HERALD','--blue','europan',0.28,0],
 ['Leads','PROSPECTOR','--blue','canyon',0.30,0],
 ['Governance','SENTINEL','--gold','saturnian',0.48,1],
 ['Memory','RECALL','--purp','carbon',0.25,0],
 ['Knowledge','RAG','--purp','uranian',0.44,1],
 ['Calendar','NOTETAKER','--blue','hazy',0.33,0]
];
const CDESC={
 Commerce:'Merchant — shop health, GMV and sync. Proposes campaigns; you approve the spend.',
 Finance:'Ledger — settlement vs GMV, margin and cash. Leadership-gated, always.',
 Creative:'Vesper — 60-slot content matrix + live auto-clips. Drafts, never publishes alone.',
 Affiliate:'Scout — sources and tiers PH creators, matches them to under-activated brands.',
 'Trend · CSI':'Oracle — competitors, trends, market moves. Every finding cites a source.',
 'Customer Care':'Care — triages tickets, pulls order + refund eligibility, drafts replies.',
 'Live Selling':'Anchor — schedules lives, tracks viewers / GMV / CTOR, coaches hosts.',
 Warehouse:'Logi — stock cover, dispatch SLA, returns. Drafts restocks, flags QC risk.',
 Reporting:'Herald — daily / weekly / monthly client reports in plain English. Human approves.',
 Leads:'Prospector — sources qualified brand and partner leads across platforms daily.',
 Governance:'Sentinel — guards money, people and deletion. Routes consequential acts to the gate.',
 Memory:'Recall — stores your edits and decisions so the next draft starts closer to right.',
 Knowledge:'RAG — grounded retrieval. Cites its source or says it does not know.',
 Calendar:'Notetaker — transcribes calls, pulls action items, drafts invites → your gate.'
};
/* Tony is a SUN. State only shifts his corona a little. */
const STATE_COL={idle:0xffb347,listening:0x8ec6ff,thinking:0xc9a6ff,speaking:0xffd166};

var Tony3D={mount(){},unmount(){},setState(){},zoom(){},reset(){},rescale(){},hasSelection(){return false;},ok:false,ready:null};
(function(){
  const API=Tony3D;
  if(typeof THREE==='undefined'){orbitFallback();return;}
  try{

  const cs=getComputedStyle(document.documentElement);
  const tok=n=>{const v=cs.getPropertyValue(n).trim()||'#8b9aa8';return parseInt(v.replace('#',''),16);};

  /* Expose the literal procedural planet-surface generator so other UI
     (the Command page department carousel) can mount the SAME textured
     planets Tony's orbit uses — not a copy, the same function. */
  API.planetTexture=(...a)=>planetTexture(...a);
  API.tok=tok;

  const SUN_R=1.75,PER_RING=5,BASE_R=5.6,RING_GAP=2.9;
  const nodes=[];let rings=0;

  for(let i=0;i<CNODES.length;i+=PER_RING){
    const ring=CNODES.slice(i,i+PER_RING),ri=rings++;
    const a=BASE_R+ri*RING_GAP,b=a*(1-(0.018+ri*0.01));
    const tilt=(ri%2?-1:1)*(3+ri*2.2)*Math.PI/180,speed=0.075/(ri*0.8+1.3);
    ring.forEach(function(n,ai){nodes.push({name:n[0],sub:n[1],color:tok(n[2]),kind:n[3],
      r:n[4],hasRing:n[5],a:a,b:b,tilt:tilt,speed:speed,
      angle:(ai/ring.length)*Math.PI*2+ri*0.4,ri:ri});});
  }
  const OUTER=BASE_R+(rings-1)*RING_GAP;

  const root=document.createElement('div');
  root.style.cssText='position:absolute;inset:0;z-index:2';
  const labelLayer=document.createElement('div');
  labelLayer.className='tlabels';
  const dimLayer=document.createElement('div');
  dimLayer.className='tdim';

  const scene=new THREE.Scene();
  const camera=new THREE.PerspectiveCamera(46,1.6,0.5,900);
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.setClearColor(0x000000,0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  if(THREE.sRGBEncoding)renderer.outputEncoding=THREE.sRGBEncoding;
  if(THREE.ACESFilmicToneMapping)renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.12;
  root.appendChild(renderer.domElement);

  /* ---- LIGHTING (reference-style: every planet legible) ------------------
     The reference lights every body clearly — Mercury next to the sun and
     Earth far out read at the same brightness. That is NOT inverse-square,
     so the sun light uses decay 0 and a strong sky fill carries the rest.
     You still get a directional day/night side; you just never lose a
     department into the dark. */
  const ambient=new THREE.HemisphereLight(0x33406b,0x0b1020,0.62);scene.add(ambient);
  const sunLight=new THREE.PointLight(0xfff0cf,1.55,0,0);scene.add(sunLight);
  const fillLight=new THREE.DirectionalLight(0x6f8fc9,0.32);
  fillLight.position.set(-8,10,-6);scene.add(fillLight);

  /* ---- tiny seeded noise kit (for planet surfaces) ---- */
  function mulberry32(seed){let a=seed>>>0;return function(){a+=0x6D2B79F5;let t=a;
    t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;};}
  function hasher(seed){
    return function(x,y){
      let h=x*374761393+y*668265263+seed*1274126177;
      h=(h^(h>>>13))*1274126177;
      return ((h^(h>>>16))>>>0)/4294967296;
    };
  }
  function vnoise(h,x,y,per){
    const xi=Math.floor(x),yi=Math.floor(y),xf=x-xi,yf=y-yi;
    const u=xf*xf*(3-2*xf),v=yf*yf*(3-2*yf);
    const w=function(i){return ((i%per)+per)%per;};
    const a=h(w(xi),yi),b=h(w(xi+1),yi),c=h(w(xi),yi+1),d=h(w(xi+1),yi+1);
    return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;
  }
  function fbm(h,x,y,oct,per){
    let val=0,amp=0.5,f=1;
    for(let i=0;i<oct;i++){val+=amp*vnoise(h,x*f,y*f,per*f);f*=2;amp*=0.5;}
    return val;
  }
  const hexRgb=function(h){return [(h>>16)&255,(h>>8)&255,h&255];};

  /* ---- planet surfaces: one generator per archetype ----------------------
     Fourteen departments, fourteen genuinely different worlds — no two share
     a generator. Each keeps ~40% of its department colour as a tint so it is
     still identifiable at a glance, but the structure underneath is its own.
     Returns {map, emissiveMap} — only the lava world uses the second. */
  function planetTexture(kind,baseHex,seed){
    const W=320,H=160;
    const cv=document.createElement('canvas');cv.width=W;cv.height=H;
    const ctx=cv.getContext('2d');
    const img=ctx.createImageData(W,H),d=img.data;
    const h=hasher(seed),h2=hasher(seed+7919),rnd=mulberry32(seed);
    const dept=hexRgb(baseHex);
    let emis=null,ed=null;
    if(kind==='lava'){
      emis=document.createElement('canvas');emis.width=W;emis.height=H;
      ed=emis.getContext('2d').createImageData(W,H);
    }
    const ridged=function(n){return 1-Math.abs(n*2-1);};

    for(let y=0;y<H;y++){
      const v=y/H,lat=(v-0.5)*2,alat=Math.abs(lat);
      for(let x=0;x<W;x++){
        const u=x/W;
        let r=0,g=0,b=0,er=0,eg=0,eb=0;

        if(kind==='terran'){
          const wx=fbm(h2,u*3,v*3,3,3)*0.6;
          const n=fbm(h,u*6+wx,v*6,5,6);
          const cl=fbm(h2,u*5+19,v*5+7,4,5);
          if(alat>0.80){r=228;g=238;b=248;}
          else if(n>0.545){const e=(n-0.545)/0.455;
            r=58+96*e;g=92+92*e;b=44+58*e;}
          else if(n>0.505){r=44;g=104;b=126;}          /* shelf */
          else{const o=n/0.505;r=10+16*o;g=38+44*o;b=84+74*o;}
          if(cl>0.60){const k=(cl-0.60)/0.40*0.8;
            r+=(248-r)*k;g+=(250-g)*k;b+=(255-b)*k;}

        }else if(kind==='ocean'){
          const wx=fbm(h2,u*2,v*2.4,3,2)*0.8;
          const n=fbm(h,u*5+wx,v*5,5,5);
          const o=Math.min(1,n/0.72);
          r=8+18*o;g=48+62*o;b=104+92*o;
          if(n>0.755){const e=(n-0.755)/0.245;r=96+70*e;g=118+62*e;b=92+40*e;}
          const storm=fbm(h2,u*7+33,v*7,4,7);
          if(storm>0.63){const k=(storm-0.63)/0.37*0.72;
            r+=(240-r)*k;g+=(246-g)*k;b+=(255-b)*k;}

        }else if(kind==='jovian'){
          const turb=fbm(h,u*9,v*13,5,9)-0.5;
          const band=Math.sin(lat*Math.PI*7.5+turb*5.4);
          const zone=band*0.5+0.5;
          r=96+150*zone;g=72+126*zone;b=52+92*zone;
          const fine=fbm(h2,u*20,v*26,3,20);
          r+=(fine-0.5)*34;g+=(fine-0.5)*28;b+=(fine-0.5)*20;

        }else if(kind==='saturnian'){
          const turb=fbm(h,u*7,v*11,4,7)-0.5;
          const band=Math.sin(lat*Math.PI*6.0+turb*2.6);
          const zone=band*0.5+0.5;
          r=176+58*zone;g=156+56*zone;b=112+50*zone;   /* soft pale gold */

        }else if(kind==='uranian'){
          const n=fbm(h,u*3,v*4,3,3);
          const band=Math.sin(lat*Math.PI*3.0)*0.5+0.5;
          const s=0.90+0.10*band+(n-0.5)*0.10;         /* nearly featureless */
          r=132*s;g=196*s;b=206*s;

        }else if(kind==='icegiant'){
          const turb=fbm(h,u*6,v*9,4,6)-0.5;
          const band=Math.sin(lat*Math.PI*4.5+turb*1.8)*0.5+0.5;
          r=(72+52*band);g=(122+64*band);b=(180+62*band);
          const spot=fbm(h2,u*9+51,v*9,3,9);
          if(spot>0.74){const k=(spot-0.74)/0.26*0.5;
            r+=(230-r)*k;g+=(238-g)*k;b+=(248-b)*k;}

        }else if(kind==='europan'){
          const cr=ridged(fbm(h,u*9,v*9,5,9));
          const cr2=ridged(fbm(h2,u*16+11,v*16,4,16));
          const ice=0.80+0.20*fbm(h,u*4,v*4,3,4);
          r=214*ice;g=226*ice;b=238*ice;
          const line=Math.max(cr>0.90?(cr-0.90)/0.10:0,cr2>0.93?(cr2-0.93)/0.07:0);
          if(line>0){r=r+(154-r)*line;g=g+(96-g)*line;b=b+(64-b)*line;}

        }else if(kind==='martian'){
          const n=fbm(h,u*8,v*8,5,8);
          const dark=fbm(h2,u*4+61,v*4,4,4);
          if(alat>0.88){r=234;g=236;b=240;}
          else{const s=0.62+0.52*n;
            r=168*s;g=92*s;b=58*s;
            if(dark<0.42){const k=(0.42-dark)/0.42*0.55;
              r-=r*0.42*k;g-=g*0.30*k;b-=b*0.14*k;}}

        }else if(kind==='lava'){
          const cr=ridged(fbm(h,u*8,v*8,5,8));
          const crust=fbm(h2,u*13,v*13,4,13);
          const base=26+34*crust;
          r=base*1.06;g=base*0.86;b=base*0.84;
          const glow=cr>0.86?(cr-0.86)/0.14:0;
          if(glow>0){
            r=r+(255-r)*glow;g=g+(126-g)*glow*0.9;b=b+(28-b)*glow*0.7;
            er=255*glow;eg=118*glow;eb=26*glow;
          }

        }else if(kind==='venusian'){
          const wx=fbm(h2,u*2,v*3.2,3,2)*1.4;
          const sw=fbm(h,u*4+wx,v*5,5,4);
          const s=0.70+0.44*sw;
          r=236*s;g=204*s;b=140*s;

        }else if(kind==='mercurial'){
          const n=fbm(h,u*12,v*12,5,12);
          const s=0.44+0.64*n;
          r=150*s;g=146*s;b=140*s;

        }else if(kind==='carbon'){
          const n=fbm(h,u*10,v*10,5,10);
          const s=0.30+0.34*n;                          /* very low albedo */
          r=64*s;g=60*s;b=70*s;

        }else if(kind==='canyon'){
          const n=fbm(h,u*9,v*9,4,9);
          const fr=ridged(fbm(h2,u*7+23,v*7,5,7));
          const s=0.56+0.58*n;
          r=172*s;g=138*s;b=104*s;
          if(fr>0.88){const k=(fr-0.88)/0.12;
            r-=r*0.55*k;g-=g*0.52*k;b-=b*0.44*k;}

        }else{ /* hazy sub-neptune */
          const turb=fbm(h,u*5,v*7,4,5)-0.5;
          const band=Math.sin(lat*Math.PI*3.6+turb*1.4)*0.5+0.5;
          const s=0.82+0.20*band;
          r=150*s;g=168*s;b=196*s;
        }

        /* ~40% department tint, luminance-preserving */
        const lum=(r*0.299+g*0.587+b*0.114)/255;
        r=r*0.60+dept[0]*lum*0.52;
        g=g*0.60+dept[1]*lum*0.52;
        b=b*0.60+dept[2]*lum*0.52;

        const i4=(y*W+x)*4;
        d[i4]=r<0?0:r>255?255:r;
        d[i4+1]=g<0?0:g>255?255:g;
        d[i4+2]=b<0?0:b>255?255:b;
        d[i4+3]=255;
        if(ed){ed.data[i4]=er;ed.data[i4+1]=eg;ed.data[i4+2]=eb;ed.data[i4+3]=255;}
      }
    }
    ctx.putImageData(img,0,0);
    if(emis)emis.getContext('2d').putImageData(ed,0,0);

    /* impact craters only where they belong */
    if(kind==='mercurial'||kind==='carbon'||kind==='canyon'){
      const n=kind==='mercurial'?34:(kind==='carbon'?22:12);
      for(let i=0;i<n;i++){
        const cx=rnd()*W,cy=20+rnd()*(H-40),rad=2+rnd()*(kind==='mercurial'?10:6);
        const gr=ctx.createRadialGradient(cx,cy,0,cx,cy,rad);
        gr.addColorStop(0,'rgba(0,0,0,0.34)');
        gr.addColorStop(0.70,'rgba(0,0,0,0.12)');
        gr.addColorStop(0.87,'rgba(255,255,255,0.16)');
        gr.addColorStop(1,'rgba(255,255,255,0)');
        ctx.fillStyle=gr;ctx.beginPath();ctx.arc(cx,cy,rad,0,Math.PI*2);ctx.fill();
      }
    }
    /* the great spot — Creative only */
    if(kind==='jovian'){
      const cx=rnd()*W,cy=H*0.62,rw=22+rnd()*10;
      const gr=ctx.createRadialGradient(cx,cy,0,cx,cy,rw);
      gr.addColorStop(0,'rgba(232,146,96,0.62)');
      gr.addColorStop(0.6,'rgba(214,124,84,0.30)');
      gr.addColorStop(1,'rgba(214,124,84,0)');
      ctx.fillStyle=gr;ctx.save();ctx.translate(cx,cy);ctx.scale(1,0.46);
      ctx.beginPath();ctx.arc(0,0,rw,0,Math.PI*2);ctx.fill();ctx.restore();
    }

    const mk=function(canvas){
      const t=new THREE.CanvasTexture(canvas);
      t.wrapS=THREE.RepeatWrapping;
      if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;
      return t;
    };
    return {map:mk(cv),emissiveMap:emis?mk(emis):null};
  }

  function glowTex(hex,soft,mid){
    const rgb=hexRgb(hex),s=128,c=document.createElement('canvas');c.width=c.height=s;
    const x=c.getContext('2d'),gr=x.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);
    gr.addColorStop(0,'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+soft+')');
    gr.addColorStop(0.38,'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+','+(soft*(mid||0.30))+')');
    gr.addColorStop(1,'rgba('+rgb[0]+','+rgb[1]+','+rgb[2]+',0)');
    x.fillStyle=gr;x.fillRect(0,0,s,s);return new THREE.CanvasTexture(c);}
  function addSprite(tex,scale,op){
    const m=new THREE.SpriteMaterial({map:tex,transparent:true,opacity:op,
      blending:THREE.AdditiveBlending,depthWrite:false});
    const sp=new THREE.Sprite(m);sp.scale.set(scale,scale,1);scene.add(sp);return sp;}
  function fresnel(hex,radius,intensity,power){
    const mat=new THREE.ShaderMaterial({
      uniforms:{glowColor:{value:new THREE.Color(hex)},intensity:{value:intensity}},
      vertexShader:'varying vec3 vN;varying vec3 vV;void main(){vN=normalize(normalMatrix*normal);'+
        'vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader:'uniform vec3 glowColor;uniform float intensity;varying vec3 vN;varying vec3 vV;'+
        'void main(){float rim=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),'+power.toFixed(1)+');'+
        'gl_FragColor=vec4(glowColor,rim*intensity);}',
      transparent:true,blending:THREE.AdditiveBlending,depthWrite:false});
    return new THREE.Mesh(new THREE.SphereGeometry(radius,32,32),mat);}

  /* ---- STARFIELD + CONSTELLATIONS + MILKY WAY ---- */
  /* ---- THE SKY ----------------------------------------------------------
     Two paths:
     (a) SKY_IMAGE_URL set → load a real equirectangular Milky Way photo.
     (b) not set, or the load fails → the procedural sky below.
     The procedural clouds are no longer scattered radial blobs (that is what
     read as a mess: ~430 unrelated smudges with no shared structure). They
     are now ONE continuous density field — domain-warped fbm, gated by a
     gaussian falloff from the galactic plane, carved by a second fbm acting
     as dust lanes. Because it is a field and not blobs, the structure comes
     out connected and filamentary, the way a real galactic plane looks. It
     is computed at 512x256 (clouds are low-frequency anyway) and upscaled
     with smoothing; stars are then drawn crisp at full res on top. */
  const SKY_IMAGE_URL='';   /* drop a CORS-enabled 4096x2048 .jpg URL here */
  const SKY_TINT=0.42;      /* photo brightness grade: 1 = untouched */

  function milkyWayTexture(){
    const CW=512,CH=256,W=2048,H=1024;
    /* --- pass 1: the cloud field, low-res --- */
    const cl=document.createElement('canvas');cl.width=CW;cl.height=CH;
    const clx=cl.getContext('2d');
    const cimg=clx.createImageData(CW,CH),cd=cimg.data;
    const hA=hasher(90210),hB=hasher(31337),hC=hasher(777);
    for(let y=0;y<CH;y++){
      const v=y/CH,lat=(v-0.5)*2;
      const plane=Math.exp(-Math.pow(lat*3.05,2));          /* galactic plane */
      for(let x2=0;x2<CW;x2++){
        const u=x2/CW;
        /* domain warp → filaments instead of round blobs */
        const wx=(fbm(hB,u*2,v*2,3,2)-0.5)*0.85;
        const wy=(fbm(hC,u*2+5,v*2,3,2)-0.5)*0.45;
        const n=fbm(hA,u*5+wx,v*5+wy,5,5);
        const dust=fbm(hB,u*4+11,v*3.5,4,4);      /* freq MUST equal period */
        /* Core bulge, offset to one side like the real thing. Distance in u
           must be measured the SHORT way around the sphere, or the bulge is
           strong at u=0 and absent at u=1 — a step right on the seam. */
        const du=Math.abs(u-0.30),dw=du<0.5?du:1-du;
        const core=Math.exp(-(Math.pow(dw*3.4,2)+Math.pow(lat*5.2,2)));
        let dens=plane*Math.max(0,(n-0.34)/0.66);
        dens=dens*(1-0.88*Math.max(0,(dust-0.46)/0.54));    /* dark lanes */
        dens=Math.min(1,dens*1.25+core*0.55);
        /* --- colour ---
           Two independent hue fields, so tone does not track brightness.
           Thin outskirts run cool (blue -> teal); dense dust runs warm
           (brown -> gold); the core goes hot and pale; and a third mask
           drops in pink/red emission regions. */
        const hu=fbm(hC,u*3+17,v*3,4,3);
        const hu2=fbm(hA,u*2+29,v*2,3,2);
        const em=fbm(hB,u*6+41,v*6+7,4,6);
        const tc=Math.max(0,Math.min(1,(hu-0.34)/0.36));
        const tw=Math.max(0,Math.min(1,(hu2-0.30)/0.42));
        const coolR=66+(74-66)*tc, coolG=112+(170-112)*tc, coolB=196+(178-196)*tc;
        const warmR=170+(242-170)*tw, warmG=110+(196-110)*tw, warmB=74+(132-74)*tw;
        const mixW=Math.min(1,dens*1.75);
        let cr=coolR+(warmR-coolR)*mixW;
        let cg=coolG+(warmG-coolG)*mixW;
        let cb=coolB+(warmB-coolB)*mixW;
        const hot=Math.min(1,core*0.95);
        cr=cr+(255-cr)*hot; cg=cg+(238-cg)*hot; cb=cb+(198-cb)*hot;
        const eM=Math.max(0,(em-0.68)/0.32)*Math.min(1,dens*2.1)*0.80;
        cr=cr+(228-cr)*eM; cg=cg+(94-cg)*eM; cb=cb+(138-cb)*eM;
        const i4=(y*CW+x2)*4;
        cd[i4]=cr*dens;
        cd[i4+1]=cg*dens;
        cd[i4+2]=cb*dens;
        cd[i4+3]=255;
      }
    }
    clx.putImageData(cimg,0,0);

    /* --- pass 2: full-res canvas, clouds upscaled + stars on top --- */
    const cv=document.createElement('canvas');cv.width=W;cv.height=H;
    const x=cv.getContext('2d');
    x.fillStyle='#010206';x.fillRect(0,0,W,H);
    x.imageSmoothingEnabled=true;
    if(x.imageSmoothingQuality)x.imageSmoothingQuality='high';
    x.globalAlpha=0.95;
    x.drawImage(cl,0,0,W,H);
    x.globalAlpha=1;

    const rnd=mulberry32(20260805);
    const gauss=function(){return (rnd()+rnd()+rnd()-1.5)/1.5;};
    x.globalCompositeOperation='lighter';
    for(let i=0;i<13000;i++){
      const inBand=rnd()<0.68;
      const cx=rnd()*W,cy=inBand?H*0.5+gauss()*H*0.145:rnd()*H;
      if(cy<0||cy>=H)continue;
      const bb=Math.pow(rnd(),2.7),a=0.08+bb*0.70;
      const s=bb>0.90?1.7:(bb>0.58?1.1:0.75);
      const t=rnd();
      const col=t<0.14?'255,206,158':(t<0.34?'182,206,255':'226,234,250');
      x.fillStyle='rgba('+col+','+a.toFixed(3)+')';
      x.fillRect(cx,cy,s,s);
    }
    /* a handful of genuinely bright stars — tight cores, small halos only.
       The old version gave these 7-17px halos, which is what showed up as
       grey smudges floating in front of the planets. */
    for(let i=0;i<70;i++){
      const cx=rnd()*W,cy=rnd()*H,t=rnd();
      const col=t<0.2?'255,214,170':(t<0.5?'190,214,255':'240,246,255');
      const rad=2.4+rnd()*2.2;
      const gr=x.createRadialGradient(cx,cy,0,cx,cy,rad);
      gr.addColorStop(0,'rgba('+col+',0.55)');
      gr.addColorStop(1,'rgba('+col+',0)');
      x.fillStyle=gr;x.beginPath();x.arc(cx,cy,rad,0,Math.PI*2);x.fill();
      x.fillStyle='rgba(255,255,255,0.95)';x.fillRect(cx,cy,1.5,1.5);
    }
    x.globalCompositeOperation='source-over';

    const tex=new THREE.CanvasTexture(cv);
    tex.wrapS=THREE.RepeatWrapping;
    tex.wrapT=THREE.ClampToEdgeWrapping;
    tex.generateMipmaps=false;
    tex.minFilter=THREE.LinearFilter;
    tex.magFilter=THREE.LinearFilter;
    if(THREE.sRGBEncoding)tex.encoding=THREE.sRGBEncoding;
    return tex;
  }

  const skyMat=new THREE.MeshBasicMaterial({map:milkyWayTexture(),
    side:THREE.BackSide,depthWrite:false,depthTest:false});
  const sky=new THREE.Mesh(new THREE.SphereGeometry(400,64,48),skyMat);
  sky.renderOrder=-1;
  sky.rotation.z=0.46;sky.rotation.x=0.22;
  scene.add(sky);

  /* photographic sky, if one is configured. Loads in the background; the
     procedural sky is already on screen, so a slow or failed fetch costs
     nothing. Graded down by SKY_TINT so it never outshines the planets. */
  if(SKY_IMAGE_URL){
    try{
      const ldr=new THREE.TextureLoader();
      ldr.setCrossOrigin('anonymous');
      ldr.load(SKY_IMAGE_URL,function(t){
        t.wrapS=THREE.RepeatWrapping;
        t.wrapT=THREE.ClampToEdgeWrapping;
        t.generateMipmaps=false;
        t.minFilter=THREE.LinearFilter;
        t.magFilter=THREE.LinearFilter;
        if(THREE.sRGBEncoding)t.encoding=THREE.sRGBEncoding;
        skyMat.map=t;
        skyMat.color.setScalar(SKY_TINT);
        skyMat.needsUpdate=true;
      },undefined,function(){
        console.warn('Sky image failed to load — keeping the procedural sky.');
      });
    }catch(e){console.warn('Sky image loader unavailable:',e);}
  }

  /* ---- 3D star layers: parallax + twinkle in front of the flat sky ---- */
  function stars(count,rMin,rMax,size,op,warmRatio){
    const p=new Float32Array(count*3),c=new Float32Array(count*3);
    for(let i=0;i<count;i++){const r=rMin+Math.random()*(rMax-rMin),th=Math.random()*Math.PI*2,
      ph=Math.acos(Math.random()*2-1);
      p[i*3]=r*Math.sin(ph)*Math.cos(th);p[i*3+1]=r*Math.sin(ph)*Math.sin(th);p[i*3+2]=r*Math.cos(ph);
      const col=Math.random()<warmRatio?[1,.9,.78]:(Math.random()<.5?[.80,.88,1]:[1,1,1]);
      c[i*3]=col[0];c[i*3+1]=col[1];c[i*3+2]=col[2];}
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(p,3));
    g.setAttribute('color',new THREE.BufferAttribute(c,3));
    return new THREE.Points(g,new THREE.PointsMaterial({size:size,sizeAttenuation:true,
      vertexColors:true,transparent:true,opacity:op}));}
  const starsNear=stars(420,40,80,0.115,0.50,0.10),
        starsFar =stars(700,80,150,0.085,0.30,0.07);
  scene.add(starsNear,starsFar);
  const STAR_SIZE_NEAR=starsNear.material.size,STAR_SIZE_FAR=starsFar.material.size;

  /* ---- constellations: the only lines left in the scene ---- */
  (function constellations(){
    const rnd=mulberry32(1337),R=95;
    const lp=[],bp=[];
    for(let c=0;c<14;c++){
      const th=rnd()*Math.PI*2,ph=Math.acos(rnd()*2-1);
      const ux=Math.sin(ph)*Math.cos(th),uy=Math.sin(ph)*Math.sin(th),uz=Math.cos(ph);
      const ax=Math.abs(uy)<0.9?[0,1,0]:[1,0,0];
      const e1=[uy*ax[2]-uz*ax[1],uz*ax[0]-ux*ax[2],ux*ax[1]-uy*ax[0]];
      const l1=Math.hypot(e1[0],e1[1],e1[2]);e1[0]/=l1;e1[1]/=l1;e1[2]/=l1;
      const e2=[uy*e1[2]-uz*e1[1],uz*e1[0]-ux*e1[2],ux*e1[1]-uy*e1[0]];
      const n=4+Math.floor(rnd()*4),pts=[];
      for(let i=0;i<n;i++){
        const s=(rnd()-0.5)*0.36,t=(rnd()-0.5)*0.36;
        const vx=ux+e1[0]*s+e2[0]*t,vy=uy+e1[1]*s+e2[1]*t,vz=uz+e1[2]*s+e2[2]*t;
        const L=Math.hypot(vx,vy,vz);
        pts.push([vx/L*R,vy/L*R,vz/L*R]);
      }
      pts.forEach(function(p){bp.push(p[0],p[1],p[2]);});
      for(let i=0;i<pts.length-1;i++){
        lp.push(pts[i][0],pts[i][1],pts[i][2]);
        lp.push(pts[i+1][0],pts[i+1][1],pts[i+1][2]);
      }
    }
    const lg=new THREE.BufferGeometry();
    lg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(lp),3));
    scene.add(new THREE.LineSegments(lg,new THREE.LineBasicMaterial({color:0x4a6f9e,
      transparent:true,opacity:0.20,blending:THREE.AdditiveBlending,depthWrite:false})));
    const bg=new THREE.BufferGeometry();
    bg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(bp),3));
    scene.add(new THREE.Points(bg,new THREE.PointsMaterial({color:0xcfe0ff,size:0.42,
      sizeAttenuation:true,transparent:true,opacity:0.62})));
  })();

  /* ---- asteroid belt (fills the outer emptiness, like the reference) ---- */
  (function belt(){
    const N=1400,BR=(BASE_R+RING_GAP)+ (RING_GAP*0.52),p=new Float32Array(N*3),c=new Float32Array(N*3);
    const rnd=mulberry32(99);
    for(let i=0;i<N;i++){
      const a=rnd()*Math.PI*2,r=BR+(rnd()-0.5)*1.15,y=(rnd()-0.5)*0.34;
      p[i*3]=Math.cos(a)*r;p[i*3+1]=y;p[i*3+2]=Math.sin(a)*r*0.995;
      const g=0.55+rnd()*0.45;
      c[i*3]=g*0.85;c[i*3+1]=g*0.80;c[i*3+2]=g*0.72;
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(p,3));
    g.setAttribute('color',new THREE.BufferAttribute(c,3));
    const belt=new THREE.Points(g,new THREE.PointsMaterial({size:0.075,sizeAttenuation:true,
      vertexColors:true,transparent:true,opacity:0.55}));
    scene.add(belt);
    API._belt=belt;
  })();

  /* ---- outer asteroid field (surrounds the whole system, past the last
     ring — chunky low-poly rocks + a wider dust haze, framed by the dark
     vignette so the scene reads as floating inside a debris field) ---- */
  (function outerField(){
    const rnd=mulberry32(4242),ORB=OUTER*1.12,ORE=OUTER*1.9;
    const N=2600,p=new Float32Array(N*3),c=new Float32Array(N*3);
    for(let i=0;i<N;i++){
      const r=ORB+rnd()*(ORE-ORB),a=rnd()*Math.PI*2,y=(rnd()-0.5)*ORB*0.6;
      p[i*3]=Math.cos(a)*r;p[i*3+1]=y;p[i*3+2]=Math.sin(a)*r;
      const g=0.45+rnd()*0.5;
      c[i*3]=g*0.80;c[i*3+1]=g*0.76;c[i*3+2]=g*0.70;
    }
    const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(p,3));
    g.setAttribute('color',new THREE.BufferAttribute(c,3));
    const dust=new THREE.Points(g,new THREE.PointsMaterial({size:0.10,sizeAttenuation:true,
      vertexColors:true,transparent:true,opacity:0.40}));
    scene.add(dust);
    API._outerDust=dust;

    const rockGeo=new THREE.IcosahedronGeometry(1,0);
    const rockMat=new THREE.MeshStandardMaterial({color:0x8a8478,roughness:0.96,
      metalness:0.04,flatShading:true});
    const boulders=new THREE.Group();
    const M=46;
    for(let i=0;i<M;i++){
      const r=ORB+rnd()*(ORE-ORB)*0.7,a=rnd()*Math.PI*2,y=(rnd()-0.5)*ORB*0.5;
      const mesh=new THREE.Mesh(rockGeo,rockMat);
      mesh.scale.setScalar(0.05+rnd()*0.17);
      mesh.rotation.set(rnd()*6.28,rnd()*6.28,rnd()*6.28);
      mesh.userData.spin=(rnd()-0.5)*0.5;
      mesh.userData.orbit=0.003+rnd()*0.009;
      mesh.userData.angle=a;mesh.userData.r=r;mesh.userData.y=y;
      mesh.position.set(Math.cos(a)*r,y,Math.sin(a)*r);
      boulders.add(mesh);
    }
    scene.add(boulders);
    API._boulders=boulders;
  })();

  /* ---- listening + speaking: one camera-facing "backdrop" plane parked
     just behind Tony -----------------------------------------------------
     Both effects used to be full rings circling the planet, which read as
     decoration wrapped around the sun instead of something Tony is
     "doing". Now they live on a single billboarded group that frame()
     re-parks each tick directly behind the sun along the current
     camera→sun sightline (see the backdrop block in frame()), so no
     matter how far the user drags the orbit, the effect always shows up
     peeking out from behind Tony rather than orbiting him. */
  const backdropGroup=new THREE.Group();scene.add(backdropGroup);
  API._backdrop=backdropGroup;

  /* ---- listening: a digital audio waveform — a row of thin white
     vertical bars whose heights pulse continuously, like a live mic
     visualizer. All geometry is authored in SUN_R-relative units and
     lives under backdropGroup, which frame() re-parks and re-scales
     (scale = clamp(activeRadius/SUN_R)) to whichever planet — or Tony
     himself — is currently active, so the waveform's on-screen size
     always tracks the active target's actual radius rather than a
     fixed/hardcoded size. Bars are a fixed pool, created once; frame()
     only ever updates their scale.y/opacity, never rebuilds them. ---- */
  const WAVE_N=22,waveGroup=new THREE.Group();
  const waveGlow=addSprite(glowTex(0xdceeff,0.5,0.4),SUN_R*4.6,0);
  scene.remove(waveGlow);waveGroup.add(waveGlow);
  /* a faint secondary cyan glow sitting behind the white bars — the subtle
     blue/cyan signal-tint the palette calls for on listening, kept low so
     white stays the bars' primary colour */
  const waveGlowCool=addSprite(glowTex(0x5ec8ff,0.34,0.42),SUN_R*3.2,0);
  scene.remove(waveGlowCool);waveGroup.add(waveGlowCool);
  const waveBars=[],WAVE_HALF_W=SUN_R*2.15,WAVE_BAR_W=SUN_R*0.055;
  for(let i=0;i<WAVE_N;i++){
    const bar=new THREE.Mesh(new THREE.BoxGeometry(WAVE_BAR_W,1,WAVE_BAR_W*0.7),
      new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,
        blending:THREE.AdditiveBlending,depthWrite:false}));
    bar.position.x=-WAVE_HALF_W+(WAVE_N===1?0:(2*WAVE_HALF_W*(i/(WAVE_N-1))));
    bar.userData.seed=i;
    waveGroup.add(bar);waveBars.push(bar);
  }
  backdropGroup.add(waveGroup);
  API._waveBars=waveBars;API._waveGlow=waveGlow;API._waveGlowCool=waveGlowCool;

  /* ---- speaking: a circular ring of many short radial segments, each
     fluctuating on its own layered frequencies — the radial sound-wave
     read from the reference, not a rotating loader. ---- */
  const SPK_N=48,speakGroup=new THREE.Group();
  const speakGlow=addSprite(glowTex(0xffd166,0.85,0.4),SUN_R*4.6,0);
  scene.remove(speakGlow);speakGroup.add(speakGlow);
  /* a faint cyan undertone behind the gold glow — the "hints of cyan" the
     solar-system palette calls for on speaking, gold stays primary */
  const speakGlowCool=addSprite(glowTex(0x6fe3ff,0.4,0.42),SUN_R*3.4,0);
  scene.remove(speakGlowCool);speakGroup.add(speakGlowCool);
  const speakBars=[];
  for(let i=0;i<SPK_N;i++){
    const bar=new THREE.Mesh(new THREE.BoxGeometry(SUN_R*0.09,1,SUN_R*0.05),
      new THREE.MeshBasicMaterial({color:0xffd166,transparent:true,opacity:0,
        blending:THREE.AdditiveBlending,depthWrite:false}));
    bar.userData.seed=i;
    speakGroup.add(bar);speakBars.push(bar);
  }
  backdropGroup.add(speakGroup);
  API._speakBars=speakBars;API._speakGlow=speakGlow;API._speakGlowCool=speakGlowCool;

  /* ---- thinking: a reasoning cluster wiring itself near the active
     planet. Kept at scene root (not the billboard group) because it wants
     real depth as it orbits, not a flat camera-facing card, and rescaled
     per-frame to the active target's own radius so nothing here is sized
     for any one planet. Nodes are lit MeshStandardMaterial spheres (the
     same ambient/point/directional lights the planets already use give
     them a real highlight+shadow gradient) instead of flat unlit
     additive-glow circles, so they read as small 3D objects floating in
     space rather than bloom. Lines use normal (non-additive) blending at
     a restrained opacity so they stay thin and clean, not neon. Fixed
     pool created once — frame() only ever updates position/scale/
     opacity on it. ---- */
  const THINK_N=7,thinkGroup=new THREE.Group(),thinkNodes=[];
  for(let i=0;i<THINK_N;i++){
    const node=new THREE.Mesh(new THREE.SphereGeometry(0.13,16,16),
      new THREE.MeshStandardMaterial({color:0xa8a0e6,roughness:0.42,metalness:0.18,
        emissive:0x2a2668,emissiveIntensity:0.55,transparent:true,opacity:0}));
    thinkGroup.add(node);thinkNodes.push(node);
  }
  const thinkLineGeo=new THREE.BufferGeometry();
  thinkLineGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(THINK_N*2*3),3));
  const thinkLines=new THREE.LineSegments(thinkLineGeo,new THREE.LineBasicMaterial({color:0x958fd6,
    transparent:true,opacity:0,depthWrite:false}));
  scene.add(thinkGroup,thinkLines);
  API._thinkNodes=thinkNodes;API._thinkLines=thinkLines;

  /* ---- THE SUN ---------------------------------------------------------- */
  /* Extracted into a factory so the Command-page Activity spotlight can
     mount the exact same animated noise-shader sun (not a copy) in its
     own tiny scene — same fbm turbulence, same colour ramp. */
  function buildSunMaterial(){
    const uni={
      t:{value:0},
      cDeep:{value:new THREE.Color(0xc85a12)},
      cMid:{value:new THREE.Color(0xffab33)},
      cHot:{value:new THREE.Color(0xfff6dc)},
      pulse:{value:1.0}
    };
    const mat=new THREE.ShaderMaterial({
      uniforms:uni,
      vertexShader:[
        'varying vec3 vPos;varying vec3 vN;varying vec3 vV;',
        'void main(){vPos=position;vN=normalize(normalMatrix*normal);',
        ' vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);',
        ' gl_Position=projectionMatrix*mv;}'].join('\n'),
      fragmentShader:[
        'uniform float t;uniform vec3 cDeep;uniform vec3 cMid;uniform vec3 cHot;uniform float pulse;',
        'varying vec3 vPos;varying vec3 vN;varying vec3 vV;',
        'float hash(vec3 p){p=fract(p*0.3183099+vec3(0.71,0.113,0.419));p*=17.0;',
        '  return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}',
        'float noise(vec3 x){vec3 i=floor(x);vec3 f=fract(x);f=f*f*(3.0-2.0*f);',
        '  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),',
        '                 mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),',
        '             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),',
        '                 mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}',
        'float fbm(vec3 p){float v=0.0;float a=0.5;',
        '  for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec3(1.7,9.2,4.3);a*=0.5;}return v;}',
        'void main(){',
        '  vec3 p=normalize(vPos);',
        '  float g1=fbm(p*3.4+vec3(0.0,t*0.04,0.0));',
        '  float g2=fbm(p*8.0-vec3(t*0.028,0.0,t*0.018));',
        '  float g=mix(g1,g2,0.45);',
        '  float mu=max(dot(normalize(vN),normalize(vV)),0.0);',
        '  float limb=pow(mu,0.42);',
        '  vec3 col=mix(cDeep,cMid,smoothstep(0.28,0.58,g));',
        '  col=mix(col,cHot,smoothstep(0.58,0.88,g));',
        '  col*=mix(0.58,1.32,limb)*pulse;',
        '  col+=cHot*pow(smoothstep(0.82,0.98,g),2.0)*0.55;',
        '  gl_FragColor=vec4(col,1.0);}'].join('\n')
    });
    return{mat,uni};
  }
  API.buildSunMaterial=buildSunMaterial;
  const {mat:sunMat,uni:sunUni}=buildSunMaterial();
  const sunMesh=new THREE.Mesh(new THREE.SphereGeometry(SUN_R,64,64),sunMat);
  scene.add(sunMesh);
  /* soft layered bloom — no streak rays */
  const bloomTex=glowTex(0xffffff,0.62,0.26);
  const bloom1=addSprite(bloomTex,SUN_R*3.6,0.60);
  const bloom2=addSprite(bloomTex,SUN_R*6.8,0.28);
  const bloom3=addSprite(bloomTex,SUN_R*12.0,0.11);
  const chromo=fresnel(0xffc46a,SUN_R*1.05,0.70,2.6);scene.add(chromo);
  const coronaCol=new THREE.Color(0xffc266);
  [bloom1,bloom2,bloom3].forEach(function(s){s.material.color.copy(coronaCol);});

  /* ---- PLANETS ---- */
  const pivots=new Map();
  nodes.forEach(function(n,idx){
    if(!pivots.has(n.ri)){
      const p=new THREE.Group();p.rotation.x=n.tilt;scene.add(p);pivots.set(n.ri,p);
      /* subtle orbit path: a thin elliptical guide matching this ring's
         own (a,b) radii exactly, added as a child of the ring's own pivot
         group so it inherits the same tilt for free and never needs its
         own per-frame update — one static LineLoop per ring, built once. */
      const OSEG=96,op=new Float32Array((OSEG+1)*3);
      for(let s=0;s<=OSEG;s++){
        const th=(s/OSEG)*Math.PI*2;
        op[s*3]=n.a*Math.cos(th);op[s*3+1]=0;op[s*3+2]=n.b*Math.sin(th);
      }
      const og=new THREE.BufferGeometry();
      og.setAttribute('position',new THREE.BufferAttribute(op,3));
      const orbitLine=new THREE.LineLoop(og,new THREE.LineBasicMaterial({color:0x5d76ab,
        transparent:true,opacity:0.12,blending:THREE.AdditiveBlending,depthWrite:false}));
      orbitLine.frustumCulled=false;
      p.add(orbitLine);
    }
    const holder=new THREE.Group();holder.visible=false;pivots.get(n.ri).add(holder);
    const tex=planetTexture(n.kind,n.color,idx*77+13);
    const mp={map:tex.map,roughness:0.88,metalness:0.03,transparent:true,opacity:1};
    if(tex.emissiveMap){mp.emissiveMap=tex.emissiveMap;
      mp.emissive=new THREE.Color(0xffffff);mp.emissiveIntensity=1.15;}
    if(n.kind==='europan'||n.kind==='icegiant')mp.roughness=0.62;
    if(n.kind==='carbon')mp.roughness=0.97;
    const mesh=new THREE.Mesh(new THREE.SphereGeometry(n.r,36,36),
      new THREE.MeshStandardMaterial(mp));
    mesh.rotation.z=(idx%5-2)*0.12;      /* varied axial tilt */
    mesh.userData.node=n;
    const AT={terran:0.34,ocean:0.36,venusian:0.40,hazy:0.32,icegiant:0.26,
      uranian:0.24,saturnian:0.20,jovian:0.20,lava:0.18};
    const atmBase=AT[n.kind]!==undefined?AT[n.kind]:0.08;
    const atm=fresnel(n.color,n.r*1.10,atmBase,3.0);
    n.atmBase=atmBase;n.hl=0;n.dimT=0;
    holder.add(mesh,atm);
    n.ring=null;
    if(n.hasRing){
      const ring=new THREE.Mesh(new THREE.RingGeometry(n.r*1.5,n.r*2.35,72),
        new THREE.MeshBasicMaterial({color:n.color,transparent:true,opacity:.36,
          side:THREE.DoubleSide,depthWrite:false}));
      if(n.kind==='uranian'){ring.rotation.x=0.12;ring.rotation.y=0.35;}
      else{ring.rotation.x=Math.PI/2.35;ring.rotation.z=-0.28;}
      holder.add(ring);
      n.ring=ring;
    }
    n.holder=holder;n.mesh=mesh;n.atm=atm;n.spin=0.18+Math.random()*0.22;

    /* ---- sun→planet connection line (drawn only while "active") ----
       Two-point line, position rewritten each frame from the sun's origin
       to this planet's live world position. Additive + low base opacity so
       it reads as an energy link, not a static orbit guide. */
    const lineGeom=new THREE.BufferGeometry();
    lineGeom.setAttribute('position',new THREE.BufferAttribute(new Float32Array(6),3));
    const lineMat=new THREE.LineBasicMaterial({color:n.color,transparent:true,
      opacity:0,blending:THREE.AdditiveBlending,depthWrite:false});
    const line=new THREE.Line(lineGeom,lineMat);
    line.visible=false;line.frustumCulled=false;
    scene.add(line);
    n.line=line;n.lineGeom=lineGeom;n.actT=0;

    /* data packet: a small glowing dot travelling along the active line,
       Tony → planet, so the connection reads as data flowing rather than
       a static beam. */
    const dotTex=glowTex(n.color,0.95,0.35);
    const dot=addSprite(dotTex,n.r*1.35,0);
    n.dot=dot;n.dotPhase=Math.random();
  });

  /* ---- labels ---- */
  const labels=[];
  function addLabel(obj,name,sub,isCore,radius){
    const el=document.createElement('div');
    el.style.opacity='0'; // No labels before the first animation frame positions them.
    el.className='tlabel'+(isCore?' core':'');
    el.innerHTML=isCore?'<div class="tn">'+name+'</div>'
      :'<div class="tn">'+name+'</div><div class="ts">'+sub+'</div>';
    labelLayer.appendChild(el);
    labels.push({obj:obj,el:el,isCore:isCore,radius:radius});
  }
  addLabel(sunMesh,'TONY','',true,SUN_R);
  nodes.forEach(function(n){addLabel(n.mesh,n.name,n.sub,false,n.r);
    const rec=labels[labels.length-1];rec.node=n;n.label=rec.el;});

  /* ---- camera ---- */
  let camTheta=0.42,camPhi=1.24,fitR=22,camR=22,userZoom=false;
  const focusTarget=new THREE.Vector3(),ZERO=new THREE.Vector3();
  const clamp=function(v,a,b){return Math.min(b,Math.max(a,v));};
  function neededR(phi){
    const w=host?host.clientWidth:800,h=host?host.clientHeight:500;
    const asp=Math.max(0.55,w/h),t=Math.tan(camera.fov*Math.PI/360);
    const vExt=OUTER*Math.abs(Math.cos(phi))+OUTER*0.20*Math.abs(Math.sin(phi))+1.5;
    const hExt=OUTER+1.4;
    return clamp(Math.max(hExt/(t*asp),vExt/t)*1.05,12,72);
  }
  function computeFit(){fitR=neededR(camPhi);}
  function curDesiredR(){
    return selected?clamp(selected.r*8.5+1.6,3.2,fitR*0.9):fitR;
  }

  /* ---- state ---- */
  let curCol=new THREE.Color(STATE_COL.idle),tgtCol=new THREE.Color(STATE_COL.idle),
      intensityTarget=1.0,curStateName='idle',speakT=0,listenT=0,thinkT=0;
  const SUNCOL=new THREE.Color(0xffc266);
  API.setState=function(st){
    curStateName=st;
    tgtCol.setHex(STATE_COL[st]!==undefined?STATE_COL[st]:STATE_COL.idle);
    intensityTarget=(st==='thinking'||st==='speaking')?1.22:(st==='listening'?1.10:1.0);
  };

  /* ---- active departments (who Tony is using right now) ----
     Accepts department names ('Commerce') or agent codes ('MERCHANT'),
     case-insensitive on the code. Call with [] to clear. Safe to call
     before mount — it only touches node state, the frame loop reads it. */
  const activeSet=new Set();
  function resolveNode(key){
    const up=String(key).toUpperCase();
    return nodes.find(function(nd){return nd.name===key||nd.sub===key||nd.sub===up;});
  }
  API.setActive=function(list){
    activeSet.clear();
    (list||[]).forEach(function(k){const n=resolveNode(k);if(n)activeSet.add(n);});
  };

  /* ---- interaction ---- */
  let host=null,dragging=false,lastX=0,lastY=0,moved=0,engaged=false;
  const ray=new THREE.Raycaster(),ptr=new THREE.Vector2();
  let selected=null,hovered=null,lastHover=0;
  /* ---- active effect target: whichever planet is selected, else Tony
     himself. The speaking/listening/thinking rig reads these two instead
     of hardcoded Tony constants, so it can attach to any planet. ---- */
  function activeRadius(){return selected?selected.r:SUN_R;}
  function activeWorldPos(){if(selected)selected.holder.getWorldPosition(activePos);else activePos.copy(sunMesh.position);return activePos;}
  function describe(n){return '🪐 '+n.name+' · '+n.sub+' — '+(CDESC[n.name]||'');}
  /* hover beats a pinned selection, which beats whatever the state cycle
     is currently saying. Hover updates instantly — a fade here would lag
     behind the pointer and feel broken. */
  function applyCap(){
    const cap=document.getElementById('orbcap');
    if(!cap)return;
    const n=hovered||selected;
    
    cap.textContent=n?describe(n):'';
  }
  function setPriority(n,on){
    if(!n)return;
    n.mesh.material.depthTest=!on;
    n.mesh.renderOrder=on?999:0;
    n.atm.material.depthTest=!on;
    n.atm.renderOrder=on?999:0;
    if(n.ring){n.ring.material.depthTest=!on;n.ring.renderOrder=on?999:0;}
  }
  function select(n){
    if(selected)setPriority(selected,false);
    selected=n;
    labels.forEach(function(l){l.el.classList.remove('sel');});
    if(n){
      n.label.classList.add('sel');
      labelLayer.appendChild(n.label);   /* float to the top of the DOM stack */
      setPriority(n,true);
    }
    applyCap();
  }
  function setHover(n){
    if(hovered===n)return;
    if(hovered)hovered.label.classList.remove('hov');
    hovered=n;
    if(n)n.label.classList.add('hov');
    if(host)host.style.cursor=n?'pointer':'';
    applyCap();
  }
  function hoverPick(e){
    if(!host)return;
    const now=performance.now();
    if(now-lastHover<33)return;          /* ~30fps is plenty for a cursor */
    lastHover=now;
    const r=host.getBoundingClientRect();
    ptr.x=((e.clientX-r.left)/r.width)*2-1;
    ptr.y=-((e.clientY-r.top)/r.height)*2+1;
    ray.setFromCamera(ptr,camera);
    const hit=ray.intersectObjects(nodes.map(function(n){return n.mesh;}),false);
    setHover(hit.length?hit[0].object.userData.node:null);
  }
  function bind(el){
    el.addEventListener('pointerdown',function(e){dragging=true;moved=0;engaged=true;
      lastX=e.clientX;lastY=e.clientY;el.classList.add('dragging');
      try{el.setPointerCapture(e.pointerId);}catch(_){}
      const h=document.getElementById('thint');if(h)h.style.opacity=0;});
    el.addEventListener('pointermove',function(e){
      if(!dragging){hoverPick(e);return;}
      el.style.cursor='';
      const dx=e.clientX-lastX,dy=e.clientY-lastY;
      moved+=Math.abs(dx)+Math.abs(dy);lastX=e.clientX;lastY=e.clientY;
      camTheta-=dx*0.005;camPhi=clamp(camPhi-dy*0.005,0.16,1.50);});
    el.addEventListener('pointerup',function(e){
      if(dragging&&moved<5&&e&&e.clientX!==undefined)pick(e);
      dragging=false;el.classList.remove('dragging');
      try{el.releasePointerCapture(e.pointerId);}catch(_){}});
    el.addEventListener('pointercancel',function(){dragging=false;el.classList.remove('dragging');});
    el.addEventListener('pointerleave',function(){setHover(null);});
    el.addEventListener('wheel',function(e){
      if(!engaged)return;
      e.preventDefault();
      userZoom=true;camR=clamp(camR+e.deltaY*0.014,curDesiredR()*0.42,curDesiredR()*1.9);},{passive:false});
  }
  function pick(e){
    const r=host.getBoundingClientRect();
    ptr.x=((e.clientX-r.left)/r.width)*2-1;
    ptr.y=-((e.clientY-r.top)/r.height)*2+1;
    ray.setFromCamera(ptr,camera);
    const hit=ray.intersectObjects(nodes.map(function(n){return n.mesh;}),false);
    const n=hit.length?hit[0].object.userData.node:null;
    select(n&&n===selected?null:n);      /* click a pinned planet to release */
  }

  let ro=null;
  function resize(){
    if(!host)return;
    const w=host.clientWidth,h=host.clientHeight;
    if(!w||!h)return;
    camera.aspect=w/h;camera.updateProjectionMatrix();
    renderer.setSize(w,h,false);
    computeFit();
    if(!userZoom)camR=fitR;else camR=clamp(camR,fitR*0.42,fitR*1.9);
  }

  /* ---- loop ---- */
  const clock=new THREE.Clock();let elapsed=0,running=false,raf=null;
  const arrivalMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
  let arrivalElapsed=0,arrivalPose=tonyArrivalPose(0,arrivalMotion.matches);
  const v=new THREE.Vector3(),cw=new THREE.Vector3(),dir=new THREE.Vector3(),
        closest=new THREE.Vector3(),lineEnd=new THREE.Vector3(),activePos=new THREE.Vector3();
  /* true when the sun sits between the camera and this body */
  function behindSun(world,camPos){
    dir.subVectors(world,camPos);
    const len=dir.length();
    if(len<0.0001)return false;
    dir.divideScalar(len);
    const t=-camPos.dot(dir);
    if(t<=0||t>=len)return false;
    closest.copy(camPos).addScaledVector(dir,t);
    return closest.length()<SUN_R*1.22;
  }
  function labelsUpdate(){
    const w=host.clientWidth,h=host.clientHeight,small=w<560;
    camera.getWorldPosition(cw);
    const projScale=h/(2*Math.tan(camera.fov*Math.PI/360));
    labels.forEach(function(l){
      l.obj.getWorldPosition(v);
      const dist=v.distanceTo(cw);
      const isSel=!l.isCore&&l.node===selected;
      const hidden=!l.isCore&&!isSel&&behindSun(v,cw);
      const px=(l.radius/Math.max(dist,0.001))*projScale;
      v.project(camera);
      const vis=(v.z<1&&!hidden)||isSel;
      let op=vis?1:0;
      if(vis&&!l.isCore){
        if(isSel)op=1;
        else if(selected)op=l.node===hovered?0.85:0.08;
        else op=clamp(1.3-(dist-(camR-OUTER))/(OUTER*2.1),0.22,1);
      }
      l.el.style.opacity=op*arrivalPose.labelOpacity;
      l.el.style.left=((v.x*0.5+0.5)*w)+'px';
      l.el.style.top=((-v.y*0.5+0.5)*h+px+7)+'px';
      const sub=l.el.querySelector('.ts');
      if(sub)sub.style.display=small?'none':'block';
    });
  }
  function updateDim(){
    /* Darkens the field of planets/asteroids so attention lands on Tony
       (the sun): either because a planet is pinned/hovered — dim centred
       on that planet — or because Tony himself is actively listening,
       thinking or speaking — dim centred on the sun, i.e. on Tony. */
    const convActive=!!curStateName&&curStateName!=='idle';
    const on=!!selected||convActive;
    dimLayer.classList.toggle('on',on);
    dimLayer.classList.toggle('conv',!selected&&convActive);
    if(!on)return;
    const target=selected?selected.holder:sunMesh;
    target.getWorldPosition(v);
    v.project(camera);
    dimLayer.style.setProperty('--fx',((v.x*0.5+0.5)*100).toFixed(2)+'%');
    dimLayer.style.setProperty('--fy',((-v.y*0.5+0.5)*100).toFixed(2)+'%');
  }
  function tick(){
    if(!running)return;
    raf=requestAnimationFrame(tick);
    if(!host||!host.isConnected){stop();return;}
    try{frame();}catch(err){console.warn('Tony orbit frame error, loop stopped →',err);API.ready=false;reportOrbitReadiness();stop();}
  }
  function frame(){
    const dt=Math.min(clock.getDelta(),0.05);elapsed+=dt;
    // Advance only with rendered frames; background tabs cannot skip the landing.
    arrivalElapsed=arrivalMotion.matches?5.6:arrivalElapsed+dt;
    arrivalPose=tonyArrivalPose(arrivalElapsed,arrivalMotion.matches);

    sunUni.t.value=elapsed;
    const beat=1+0.018*Math.sin(elapsed*0.9)+0.010*Math.sin(elapsed*2.3);
    sunUni.pulse.value=beat;
    sunMesh.rotation.y+=dt*(0.024+arrivalPose.spin*0.6);
    curCol.lerp(tgtCol,Math.min(1,dt*2.4));
    coronaCol.copy(SUNCOL).lerp(curCol,0.38);
    const baseOp=[0.60,0.28,0.11];
    [bloom1,bloom2,bloom3].forEach(function(s,i){
      s.material.color.copy(coronaCol);
      s.material.opacity=baseOp[i]*intensityTarget*beat;
    });
    chromo.material.uniforms.glowColor.value.copy(coronaCol);
    sunLight.color.copy(new THREE.Color(0xfff0cf)).lerp(curCol,0.22);
    sunLight.intensity=1.55*intensityTarget;

    nodes.forEach(function(n,index){
      // The loading motion and the usable scene share these same planet meshes.
      // Once settled, their orbital positions stay fixed; axial rotation remains.
      const ang=n.angle+arrivalPose.offset;
      const reveal=tonyPlanetReveal(arrivalElapsed,index,arrivalMotion.matches);
      n.holder.visible=reveal>0;
      n.holder.scale.setScalar(0.65+0.35*reveal);
      n.holder.position.set(n.a*Math.cos(ang),0,n.b*Math.sin(ang));
      n.mesh.rotation.y+=dt*n.spin;
      /* eased, so hovering in and out glides instead of popping */
      const tgt=selected===n?1:(hovered===n?0.66:0);
      n.hl+=(tgt-n.hl)*Math.min(1,dt*9);
      n.mesh.scale.setScalar(1+0.34*n.hl);

      /* active link: AI-driven use OR the planet you've selected, either
         lights the link. Growth (not just opacity) is driven by the same
         eased value, so the beam visibly extends outward from Tony to the
         planet rather than snapping into place at full length. */
      const activeTgt=(activeSet.has(n)||n===selected)?1:0;
      n.actT+=(activeTgt-n.actT)*Math.min(1,dt*2.6);
      if(n.actT>0.003){
        n.line.visible=true;
        n.holder.getWorldPosition(lineEnd);
        const p=n.lineGeom.attributes.position.array;
        const g=Math.min(1,n.actT*1.15);      /* grows slightly ahead of the fade-in */
        p[0]=0;p[1]=0;p[2]=0;p[3]=lineEnd.x*g;p[4]=lineEnd.y*g;p[5]=lineEnd.z*g;
        n.lineGeom.attributes.position.needsUpdate=true;
        n.line.material.opacity=n.actT*(0.55+0.25*Math.sin(elapsed*6+n.ri));
        /* data packet travelling Tony → planet along the same beam */
        n.dotPhase=(n.dotPhase+dt*0.55)%1;
        n.dot.position.set(lineEnd.x*g*n.dotPhase,lineEnd.y*g*n.dotPhase,lineEnd.z*g*n.dotPhase);
        n.dot.material.opacity=n.actT*0.9*Math.sin(Math.PI*n.dotPhase);
      }else if(n.line.visible){
        n.line.visible=false;
        n.dot.material.opacity=0;
      }

      /* focus dim: everything but the selected planet fades back, and
         cannot visually compete with (or hide behind) it. */
      const dimTgt=selected&&n!==selected?1:0;
      n.dimT+=(dimTgt-n.dimT)*Math.min(1,dt*3);
      const dimMul=(1-0.82*n.dimT)*reveal;
      n.mesh.material.opacity=dimMul;
      if(n.ring)n.ring.material.opacity=0.36*dimMul;
      n.atm.material.uniforms.intensity.value=(n.atmBase+(0.50-n.atmBase)*Math.max(n.hl,n.actT*0.7))*dimMul;
    });
    if(API._belt)API._belt.rotation.y+=dt*0.012;
    if(API._outerDust)API._outerDust.rotation.y+=dt*0.005;
    if(API._boulders)API._boulders.children.forEach(function(b){
      b.rotation.x+=dt*b.userData.spin*0.6;b.rotation.y+=dt*b.userData.spin;
      b.userData.angle+=dt*b.userData.orbit;
      b.position.set(Math.cos(b.userData.angle)*b.userData.r,b.userData.y,Math.sin(b.userData.angle)*b.userData.r);
    });

    const speakTgt=curStateName==='speaking'?1:0;
    speakT+=(speakTgt-speakT)*Math.min(1,dt*3);
    const listenTgt=curStateName==='listening'?1:0;
    listenT+=(listenTgt-listenT)*Math.min(1,dt*3);
    const thinkTgt=curStateName==='thinking'?1:0;
    thinkT+=(thinkTgt-thinkT)*Math.min(1,dt*3);

    /* Park the listening/speaking backdrop directly behind Tony, from the
       camera's current point of view. Recomputed every frame so dragging
       the orbit never leaves it circling the planet — it always reads as
       something happening behind him. */
    /* Whichever planet is currently selected is the effect target; with
       nothing selected it's Tony. Every state effect below reads these
       two instead of a hardcoded Tony position/size. */
    const aR=activeRadius(),aPos=activeWorldPos();

    if(API._backdrop&&(listenT>0.003||speakT>0.003)){
      const camToTarget=v.copy(aPos).sub(camera.position).normalize();
      const backPos=cw.copy(aPos).add(camToTarget.multiplyScalar(aR*2.1));
      API._backdrop.position.copy(backPos);
      API._backdrop.quaternion.copy(camera.quaternion);
      API._backdrop.scale.setScalar(clamp(aR/SUN_R,0.24,1));
    }

    /* listening: a digital audio waveform — each bar's height is driven
       by its own blend of layered sine frequencies (same technique as the
       speaking bars below) so the whole row reads as a live, continuously
       varying audio wave rather than a static shape. Only scale.y and
       opacity are touched per frame — bar count, width and x-position
       were fixed once at creation. */
    if(API._waveBars){
      const maxH=SUN_R*1.55;
      API._waveBars.forEach(function(bar){
        const seed=bar.userData.seed;
        const n1=Math.sin(elapsed*4.1+seed*0.9),n2=Math.sin(elapsed*6.7+seed*2.3+1.1),
              n3=Math.sin(elapsed*2.3+seed*0.53);
        const env=0.18+0.82*Math.abs(n1*0.5+n2*0.33+n3*0.17);
        bar.scale.y=Math.max(0.001,maxH*env)*listenT;
        bar.material.opacity=listenT*(0.55+0.45*env);
      });
    }
    if(API._waveGlow)API._waveGlow.material.opacity=listenT*0.32;
    if(API._waveGlowCool)API._waveGlowCool.material.opacity=listenT*0.24;

    /* speaking: many short bars ringed around the target, each on its own
       blend of frequencies — an organic radial sound-wave, not a spinner.
       Each bar's inner edge is anchored at a fixed radius (SPK_GAP, in
       planet-radius units — 1.0 in this local frame == the target's own
       surface, since backdropGroup's scale already maps local SUN_R
       units to the active target's actual radius) and it grows outward
       from there, so no matter how tall the envelope pushes a bar it can
       never reach back in and touch the planet. */
    if(API._speakBars){
      const SPK_GAP=SUN_R*1.22;
      API._speakBars.forEach(function(bar){
        const seed=bar.userData.seed;
        const n1=Math.sin(elapsed*3.1+seed*0.7),n2=Math.sin(elapsed*5.3+seed*1.9+1.7),
              n3=Math.sin(elapsed*1.7+seed*0.31);
        const env=0.25+0.75*Math.abs(n1*0.5+n2*0.35+n3*0.15);
        const ang=(seed/SPK_N)*Math.PI*2;
        const h=Math.max(0.001,SUN_R*(0.18+0.85*env))*speakT;
        const rMid=SPK_GAP+h/2;
        bar.position.set(Math.cos(ang)*rMid,Math.sin(ang)*rMid,0);
        bar.rotation.z=ang+Math.PI/2;
        bar.scale.y=h;
        bar.material.opacity=speakT*(0.55+0.45*env);
      });
    }
    if(API._speakGlow)API._speakGlow.material.opacity=speakT*0.5;
    if(API._speakGlowCool)API._speakGlowCool.material.opacity=speakT*0.22;

    /* thinking: a small, organized reasoning ring orbiting just outside the
       active planet — lit 3D spheres (shaded by the scene's existing
       lights, not flat glow) linked by thin, restrained lines. Every node
       shares one rigid rotation (same speed, same direction, fixed angular
       offset by index) instead of each spinning on its own speed/direction
       — that keeps their order around the ring constant forever, so the
       loop connecting consecutive nodes can never cross itself. The ring
       is tilted once (not wobbled per-node) for an orbital, not flat,
       read. Radius is a factor of aR that never dips to 1.0 (the planet's
       own surface), so there's always a small, consistent gap. Size comes
       entirely from the active target's own radius (aR/SUN_R), with a
       floor so it stays legible on small planets too. */
    if(API._thinkNodes&&API._thinkLines){
      const arr=API._thinkLines.geometry.attributes.position.array;
      const s=clamp(aR/SUN_R,0.45,1);
      const N=API._thinkNodes.length,TILT=0.55,cosT=Math.cos(TILT),sinT=Math.sin(TILT);
      const spin=0;
      API._thinkNodes.forEach(function(node,i){
        const rr=aR*(1.42+0.05*Math.sin(i*2.1));           /* fixed per-node radius — order never changes */
        const a=spin+i*(Math.PI*2/N);
        const lx=Math.cos(a)*rr,lz=Math.sin(a)*rr;          /* point on the ring's own flat plane */
        const x=aPos.x+lx,y=aPos.y-lz*sinT,z=aPos.z+lz*cosT; /* tilt the whole ring for a 3D orbital read */
        const pulse=0.94+0.07*Math.sin(elapsed*1.3+i*1.1);   /* gentle breathing only — no position jitter */
        node.position.set(x,y,z);
        node.scale.setScalar(s*pulse);
        node.material.opacity=0;
        arr[i*6]=x;arr[i*6+1]=y;arr[i*6+2]=z;
      });
      for(let i=0;i<N;i++){
        const nx=API._thinkNodes[(i+1)%N].position;
        arr[i*6+3]=nx.x;arr[i*6+4]=nx.y;arr[i*6+5]=nx.z;
      }
      API._thinkLines.geometry.attributes.position.needsUpdate=true;
      API._thinkLines.material.opacity=0;
    }

    const flicker=speakT*(0.16*Math.sin(elapsed*9.4)+0.09*Math.sin(elapsed*23.1)+0.11*Math.sin(elapsed*5.7));
    const tw=0.34+0.10*Math.sin(elapsed*0.5)+flicker;
    starsNear.material.opacity=clamp(tw,0.08,1);
    starsFar.material.opacity=clamp(tw*0.58,0.05,1);
    starsNear.material.size=STAR_SIZE_NEAR*(1+speakT*0.55*Math.abs(Math.sin(elapsed*9.4)));
    starsFar.material.size=STAR_SIZE_FAR*(1+speakT*0.35*Math.abs(Math.sin(elapsed*9.4)));

    // Keep the landed composition still. Pointer dragging can still orbit the camera.
    fitR=neededR(camPhi);
    /* focus: ease the look-at point onto the selected planet (tracking its
       orbit live), and pull the camera in tight. No selection → drift back
       to the sun at the whole-system framing. */
    if(selected){selected.holder.getWorldPosition(v);focusTarget.lerp(v,Math.min(1,dt*3));}
    else{focusTarget.lerp(ZERO,Math.min(1,dt*3));}
    const desiredR=curDesiredR();
    if(!userZoom)camR+=(desiredR-camR)*Math.min(1,dt*2.2);
    else camR=clamp(camR,desiredR*0.42,desiredR*1.9);
    const x=camR*Math.sin(camPhi)*Math.sin(camTheta),
          z=camR*Math.sin(camPhi)*Math.cos(camTheta),
          y=camR*Math.cos(camPhi);
    camera.position.set(focusTarget.x+x,focusTarget.y+y,focusTarget.z+z);
    camera.lookAt(focusTarget);
    sky.position.copy(camera.position);

    renderer.render(scene,camera);
    labelsUpdate();
    updateDim();
    if(arrivalPose.settled&&API.ready!==true){API.ready=true;reportOrbitReadiness();}
  }
  function stop(){running=false;if(raf)cancelAnimationFrame(raf);raf=null;}

  API.ok=true;
  API.mount=function(){
   try{
    const el=document.getElementById('tstage');
    if(!el)return;
    if(host!==el){
      host=el;
      el.insertBefore(root,el.firstChild);
      el.appendChild(dimLayer);
      el.appendChild(labelLayer);
      bind(el);
      if(ro)ro.disconnect();
      ro=new ResizeObserver(resize);ro.observe(el);
    }
    const meta=document.getElementById('tmeta');
    if(meta)meta.textContent=nodes.length+' agents · '+rings+' orbit rings · live';
    resize();
    if(!running){running=true;clock.getDelta();tick();}
   }catch(err){console.warn('Tony orbit mount failed →',err);API.ready=false;reportOrbitReadiness();stop();}
  };
  API.hasSelection=function(){return !!(selected||hovered);};
  API.unmount=function(){stop();setHover(null);host=null;if(ro){ro.disconnect();ro=null;}};
  API.zoom=function(dir){userZoom=true;camR=clamp(camR+dir*2.4,curDesiredR()*0.42,curDesiredR()*1.9);};
  /* The stage is scaled by CSS, so the WebGL buffer must be scaled to match
     or the orbit renders soft on retina / large displays. Layout size never
     changes — only the backing-store resolution does. */
  API.rescale=function(s){
    try{renderer.setPixelRatio(Math.min((window.devicePixelRatio||1)*(s||1),2.5));resize();}catch(_){}
  };
  API.reset=function(){userZoom=false;camR=fitR;camTheta=0.42;camPhi=1.24;setHover(null);select(null);};
  document.addEventListener('visibilitychange',function(){
    if(document.hidden)stop();
    else if(host&&host.isConnected&&!running){running=true;clock.getDelta();tick();}
  });

  }catch(err){
    console.warn('Tony 3D orbit unavailable →',err);
    orbitFallback();
  }
})();
function orbitFallback(){
  Tony3D.ok=false;
  Tony3D.ready=false;
  Tony3D.mount=function(){
    const el=document.getElementById('tstage');
    if(el&&!el.querySelector('.tfallback'))
      el.insertAdjacentHTML('beforeend',
        '<div class="tfallback">The 3D view needs WebGL.<br>Every other part of this page runs as normal.</div>');
  };
  Tony3D.unmount=function(){};Tony3D.setState=function(){};
  Tony3D.zoom=function(){};Tony3D.reset=function(){};Tony3D.rescale=function(){};
  Tony3D.hasSelection=function(){return false;};
}


function reportOrbitReadiness(){
 if(typeof Tony3D.ready==='boolean')parent.postMessage({source:'tony-orbit',ready:Tony3D.ready},parent.location.origin);
}
window.addEventListener('message', function(e){
 if(e.source!==parent || e.origin!==parent.location.origin || e.data?.source!=='tony-host')return;
 const m=e.data;
 if(m.action==='ready')reportOrbitReadiness();
 if(m.action==='state' && ['idle','listening','thinking','speaking'].includes(m.state)) Tony3D.setState(m.state);
 if(m.action==='zoom' && (m.direction===-1 || m.direction===1))Tony3D.zoom(m.direction);
 if(m.action==='reset')Tony3D.reset();
});
Tony3D.mount();
reportOrbitReadiness();
