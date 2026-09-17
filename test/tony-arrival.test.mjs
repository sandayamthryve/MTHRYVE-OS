import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/tony/orbit.js',import.meta.url),'utf8');
const context={};
vm.runInNewContext(source.slice(0,source.indexOf('/* name, agent')),context);
const pose=(seconds,reduced)=>context.tonyArrivalPose(seconds*.72,reduced);

test('all planets make one revolution and settle exactly at their assigned angle',()=>{
  assert.equal(pose(0,false).offset,-Math.PI*2);
  for(const angle of [0,.4,1.7,4.9,6.1]) {
    assert.equal(angle+pose(5,false).offset,angle);
    assert.equal(angle+pose(1000,false).offset,angle);
  }
  assert.equal(pose(4.999,false).settled,false);
  assert.equal(pose(5,false).settled,true);
});
test('orbit accelerates in its first half and decelerates to a stop',()=>{
  const velocity=t=>(pose(t+.001,false).offset-pose(t,false).offset)/.001;
  assert.ok(velocity(.1)<velocity(1));
  assert.ok(velocity(1)<velocity(2.4));
  assert.ok(velocity(2.6)>velocity(4));
  assert.ok(velocity(4)>velocity(4.9));
  assert.ok(velocity(4.999)<.00001);
  for(let t=0;t<=6;t+=.01)assert.ok(pose(t,false).offset<=0);
});
test('planets reveal in order and are all visible before settlement',()=>{
  const reveal=(seconds,index,reduced)=>context.tonyPlanetReveal(seconds*.72,index,reduced);
  for(let i=0;i<14;i++){
    const start=.3+i*.13;
    assert.equal(reveal(start-.001,i,false),0);
    assert.ok(reveal(start+.1,i,false)>0);
    assert.equal(reveal(4.99,i,false),1);
    assert.equal(reveal(0,i,true),1);
    if(i<13)assert.equal(reveal(start+.1,i+1,false),0);
  }
});
test('labels arrive near the end and reduced motion skips the travel',()=>{
  assert.equal(pose(0,false).labelOpacity,0);
  assert.equal(pose(5,false).labelOpacity,0);
  assert.ok(Math.abs(pose(5.6,false).labelOpacity-1)<1e-12);
  const reduced=pose(0,true);
  assert.equal(Math.abs(reduced.offset),0);
  assert.equal(reduced.settled,true);
  assert.equal(reduced.labelOpacity,1);
});
test('a fresh scene repeats the arrival without accumulating orbital drift',()=>{
  for(let visit=0;visit<3;visit++){
    assert.equal(pose(0,false).settled,false);
    assert.equal(pose(6,false).settled,true);
  }
  assert.ok(source.includes('const ang=n.angle+arrivalPose.offset;'));
  assert.ok(source.includes('if(arrivalPose.settled&&API.ready!==true)'));
  assert.ok(!source.includes('camTheta+=dt*0.035'));
});
test('shorter timeline settles at 3.6 seconds and initial visuals are hidden',()=>{
  assert.equal(context.tonyArrivalPose(3.599,false).settled,false);
  assert.equal(context.tonyArrivalPose(3.6,false).settled,true);
  assert.ok(source.includes('holder.visible=false;'));
  assert.ok(source.includes("el.style.opacity='0';"));
  const component=readFileSync(new URL('../components/tony/TonyNorthStarPage.tsx',import.meta.url),'utf8');
  assert.ok(component.includes('[orbitMounted, setOrbitMounted] = useState(false)'));
  assert.ok(component.includes('orbitMounted && <iframe'));
});
