(function(){
  'use strict';

  if(!window.THREE || !window.Tony3D || !Tony3D.ok || !Tony3D.buildSunMaterial){
    return;
  }

  Tony3D.unmount();
  var hidden=document.getElementById('tstage');
  if(hidden) hidden.remove();

  var canvas=document.getElementById('preview');
  if(!canvas) return;

  var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:true,premultipliedAlpha:true});
  renderer.setClearColor(0x000000,0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
  if(THREE.sRGBEncoding) renderer.outputEncoding=THREE.sRGBEncoding;
  if(THREE.ACESFilmicToneMapping) renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.16;

  var scene=new THREE.Scene();
  var camera=new THREE.PerspectiveCamera(38,1,0.1,50);
  camera.position.set(0,0.05,3.0);
  camera.lookAt(0,0,0);

  scene.add(new THREE.HemisphereLight(0x26375b,0x07101a,0.78));
  var key=new THREE.DirectionalLight(0xffecc6,1.2);
  key.position.set(-3,4,5);
  scene.add(key);

  var group=new THREE.Group();
  scene.add(group);

  var sun=Tony3D.buildSunMaterial();
  var sunUniforms=sun.uni;
  var sphere=new THREE.Mesh(new THREE.SphereGeometry(1,64,64),sun.mat);
  group.add(sphere);

  var rimMaterial=new THREE.ShaderMaterial({
    uniforms:{
      glowColor:{value:new THREE.Color(0xffc46a)},
      intensity:{value:0.9}
    },
    vertexShader:'varying vec3 vN;varying vec3 vV;void main(){vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
    fragmentShader:'uniform vec3 glowColor;uniform float intensity;varying vec3 vN;varying vec3 vV;void main(){float rim=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),2.6);gl_FragColor=vec4(glowColor,rim*intensity);}',
    transparent:true,
    blending:THREE.AdditiveBlending,
    depthWrite:false
  });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(1.06,40,40),rimMaterial));

  var haloMaterial=new THREE.MeshBasicMaterial({
    color:0xffbe66,
    transparent:true,
    opacity:0.11,
    blending:THREE.AdditiveBlending,
    depthWrite:false
  });
  group.add(new THREE.Mesh(new THREE.SphereGeometry(1.14,32,32),haloMaterial));

  function resize(){
    var w=Math.max(1,canvas.clientWidth);
    var h=Math.max(1,canvas.clientHeight);
    renderer.setSize(w,h,false);
    camera.aspect=w/h;
    camera.updateProjectionMatrix();
  }

  var observer=new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  var last=performance.now();
  function frame(now){
    var dt=Math.min(.05,(now-last)/1000);
    last=now;
    group.rotation.y+=dt*.16;
    group.rotation.x=.025*Math.sin(now/1800);
    if(sunUniforms){
      if(sunUniforms.t) sunUniforms.t.value=now/1000;
      if(sunUniforms.pulse) sunUniforms.pulse.value=1+.035*Math.sin(now/520);
    }
    haloMaterial.opacity=.095+.035*(.5+.5*Math.sin(now/620));
    renderer.render(scene,camera);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
})();
