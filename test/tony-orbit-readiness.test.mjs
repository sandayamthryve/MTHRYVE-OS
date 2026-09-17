// Run with Node 24+: node --test test/tony-orbit-readiness.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { watchOrbitReadiness } from '../lib/tony/orbit-readiness.ts';

function harness(t, onProbe = () => {}) {
  t.mock.timers.enable({apis:['setTimeout','setInterval']});
  const listeners = new Set(), results = [], probes = [];
  const frame = {postMessage(message,origin){probes.push({message,origin});onProbe(emit);}};
  const hostWindow = {
    location:{origin:'https://tony.test'},
    addEventListener(name, listener){listeners.add(listener);},
    removeEventListener(name, listener){listeners.delete(listener);},
  };
  function emit(ready, overrides={}) {
    for(const listener of [...listeners])listener({source:frame,origin:hostWindow.location.origin,data:{source:'tony-orbit',ready},...overrides});
  }
  const start = () => watchOrbitReadiness({hostWindow,getFrameWindow:()=>frame,onSettled:ready=>results.push(ready)});
  return {start,emit,results,probes,listeners};
}

test('first visit and repeated mounts each wait for a new scene',t=>{
  const h=harness(t);
  for(let visit=0;visit<3;visit++){
    h.start();
    assert.equal(h.results.length,visit);
    h.emit(true);
    assert.equal(h.results.length,visit+1);
    assert.equal(h.listeners.size,0);
  }
  assert.deepEqual(h.results,[true,true,true]);
});
test('cached iframe ready before subscription is recovered by a probe',t=>{
  const h=harness(t,emit=>emit(true));
  h.start();
  assert.deepEqual(h.results,[true]);
  assert.equal(h.probes[0].message.action,'ready');
});
test('foreign, stale-frame and malformed messages cannot dismiss loading',t=>{
  const h=harness(t);h.start();
  h.emit(true,{origin:'https://other.test'});
  h.emit(true,{source:{}});
  h.emit(true,{data:{source:'other',ready:true}});
  h.emit(null);h.emit('true');
  t.mock.timers.tick(1000);
  assert.deepEqual(h.results,[]);
  assert.ok(h.probes.length>1);
  h.emit(true);
  assert.deepEqual(h.results,[true]);
});
test('scene failure stops loading and a retry starts a fresh watcher',t=>{
  const h=harness(t);h.start();h.emit(false);
  assert.deepEqual(h.results,[false]);
  h.start();h.emit(true);
  assert.deepEqual(h.results,[false,true]);
});
test('blocked scripts time out instead of leaving a permanent overlay',t=>{
  const h=harness(t);h.start();
  t.mock.timers.tick(14999);assert.deepEqual(h.results,[]);
  t.mock.timers.tick(1);assert.deepEqual(h.results,[false]);
  h.emit(true);assert.deepEqual(h.results,[false]);
  assert.equal(h.listeners.size,0);
});
test('unmount/Strict Mode cleanup cancels listeners, timers and state updates',t=>{
  const h=harness(t),dispose=h.start();dispose();
  const count=h.probes.length;
  h.emit(true);t.mock.timers.tick(30000);
  assert.deepEqual(h.results,[]);assert.equal(h.probes.length,count);
  assert.equal(h.listeners.size,0);
});
test('iframe bridge reports rendered readiness, not renderer construction',()=>{
  const source=readFileSync(new URL('../public/tony/orbit.js',import.meta.url),'utf8');
  const bridge=source.slice(source.indexOf('function reportOrbitReadiness(){'));
  const messages=[],listeners=[];
  const parent={location:{origin:'https://tony.test'},postMessage:data=>messages.push(data)};
  const context={parent,window:{addEventListener:(name,fn)=>listeners.push(fn)},Tony3D:{ok:true,ready:null,mount(){}}};
  vm.runInNewContext(bridge,context);
  const probe=()=>listeners[0]({source:parent,origin:parent.location.origin,data:{source:'tony-host',action:'ready'}});
  probe();assert.equal(messages.length,0);
  context.Tony3D.ready=true;probe();assert.equal(messages.at(-1).ready,true);
  context.Tony3D.ready=false;probe();assert.equal(messages.at(-1).ready,false);
  assert.ok(source.indexOf('renderer.render(scene,camera);')<source.indexOf('API.ready=true;reportOrbitReadiness();'));
});
