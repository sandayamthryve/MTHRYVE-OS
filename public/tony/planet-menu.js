(function(){
  const stage=document.getElementById('tstage');
  if(!stage)return;

  const style=document.createElement('style');
  style.textContent=`
    .planet-action-trigger{position:absolute;z-index:31;display:none;width:46px;height:46px;padding:0;border:3px solid rgba(3,35,55,.9);border-radius:50%;background:#20759b;box-shadow:inset 0 0 0 1px rgba(89,195,235,.08),0 4px 12px rgba(0,0,0,.34);color:#07151e;font:900 24px/1 Arial,sans-serif;letter-spacing:1px;text-align:center;cursor:pointer;transform:translate(-50%,-50%);transition:transform .13s ease,background .13s ease,box-shadow .13s ease}
    .planet-action-trigger.visible{display:grid;place-items:center;animation:planetTriggerIn .13s ease-out}
    .planet-action-trigger:hover,.planet-action-trigger:focus-visible,.planet-action-trigger[aria-expanded="true"]{outline:none;background:#2b86ad;transform:translate(-50%,-50%) scale(1.06);box-shadow:inset 0 0 0 1px rgba(115,211,246,.12),0 0 15px rgba(36,137,180,.22),0 4px 12px rgba(0,0,0,.4)}
    .planet-action-trigger .dots{display:flex;align-items:center;justify-content:center;gap:3px;pointer-events:none}.planet-action-trigger .dots i{display:block;width:4px;height:4px;border-radius:50%;background:#06151e}
    .planet-actions{position:absolute;z-index:32;display:none;width:164px;padding:6px;border:1px solid rgba(56,132,163,.28);border-radius:10px;background:rgba(4,12,18,.96);box-shadow:0 14px 34px rgba(0,0,0,.58);backdrop-filter:blur(14px);font-family:'Rajdhani',ui-sans-serif,system-ui,sans-serif;color:#d7edf6;transform:translate(0,8px)}
    .planet-actions.open{display:block;animation:planetMenuIn .13s ease-out}
    .planet-actions button{display:flex;width:100%;align-items:center;gap:8px;padding:9px 10px;border:0;border-radius:7px;background:transparent;color:#b9d0da;font:700 11px/1 'Rajdhani',ui-sans-serif,sans-serif;letter-spacing:.04em;text-align:left;cursor:pointer;transition:.12s}
    .planet-actions button:hover,.planet-actions button:focus-visible{outline:none;background:rgba(32,117,155,.18);color:#fff}.planet-actions button span{width:17px;text-align:center;color:#55b6d9}
    @keyframes planetTriggerIn{from{opacity:0;transform:translate(-50%,-50%) scale(.78)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
    @keyframes planetMenuIn{from{opacity:0;transform:translate(0,2px) scale(.97)}to{opacity:1;transform:translate(0,8px) scale(1)}}
  `;
  document.head.appendChild(style);

  const trigger=document.createElement('button');
  trigger.type='button';
  trigger.className='planet-action-trigger';
  trigger.innerHTML='<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';
  trigger.setAttribute('aria-label','Planet actions');
  trigger.setAttribute('aria-haspopup','menu');
  trigger.setAttribute('aria-expanded','false');
  trigger.setAttribute('aria-controls','planet-actions-menu');
  stage.appendChild(trigger);

  const menu=document.createElement('div');
  menu.id='planet-actions-menu';
  menu.className='planet-actions';
  menu.setAttribute('role','menu');
  menu.innerHTML='<button type="button" data-action="chat" role="menuitem"><span>✦</span>Open in Chat</button><button type="button" data-action="settings" role="menuitem"><span>⚙</span>Settings</button>';
  stage.appendChild(menu);

  let current=null,trackedLabel=null,raf=0;
  function selectedLabel(){return document.querySelector('.tlabel.sel:not(.core)');}
  function closeMenu(returnFocus){menu.classList.remove('open');trigger.setAttribute('aria-expanded','false');if(returnFocus&&trigger.classList.contains('visible'))trigger.focus();}
  function hideAll(){closeMenu(false);trigger.classList.remove('visible');trackedLabel=null;current=null;}
  function readLabel(label){return {name:(label.querySelector('.tn')?.textContent||'Planet').trim(),agent:(label.querySelector('.ts')?.textContent||'Agent').trim()};}
  function sync(){
    const label=selectedLabel();
    if(!label){hideAll();raf=requestAnimationFrame(sync);return;}
    if(label!==trackedLabel){trackedLabel=label;current=readLabel(label);trigger.setAttribute('aria-label','Actions for '+current.agent);closeMenu(false);}
    const left=parseFloat(label.style.left),top=parseFloat(label.style.top);
    if(Number.isFinite(left)&&Number.isFinite(top)){
      /* Put the action node immediately to the left of the selected planet label,
         matching the small blue orbit nodes in the Tony scene. */
      const x=Math.max(28,Math.min(stage.clientWidth-28,left-86));
      const y=Math.max(28,Math.min(stage.clientHeight-28,top-14));
      trigger.style.left=x+'px';trigger.style.top=y+'px';trigger.classList.add('visible');
      if(menu.classList.contains('open')){
        const menuX=Math.max(8,Math.min(stage.clientWidth-172,x-82));
        const menuY=Math.max(8,Math.min(stage.clientHeight-96,y+30));
        menu.style.left=menuX+'px';menu.style.top=menuY+'px';
      }
    }
    raf=requestAnimationFrame(sync);
  }

  ['pointerdown','pointerup'].forEach(type=>trigger.addEventListener(type,e=>e.stopPropagation()));
  trigger.addEventListener('click',function(e){
    e.stopPropagation();if(!current)return;
    const opening=!menu.classList.contains('open');
    if(opening){menu.classList.add('open');trigger.setAttribute('aria-expanded','true');const x=parseFloat(trigger.style.left)||0,y=parseFloat(trigger.style.top)||0;menu.style.left=Math.max(8,Math.min(stage.clientWidth-172,x-82))+'px';menu.style.top=Math.max(8,Math.min(stage.clientHeight-96,y+30))+'px';}
    else closeMenu(false);
  });
  ['pointerdown','pointerup'].forEach(type=>menu.addEventListener(type,e=>e.stopPropagation()));
  menu.addEventListener('click',function(e){
    e.stopPropagation();const button=e.target.closest('button[data-action]');if(!button||!current)return;
    if(button.dataset.action==='chat')parent.location.href='/assistant?view=chat';
    else if(button.dataset.action==='settings')parent.location.href='/tony';
    closeMenu(false);
  });
  document.addEventListener('pointerdown',function(e){if(!menu.contains(e.target)&&!trigger.contains(e.target))closeMenu(false);});
  window.addEventListener('keydown',function(e){if(e.key==='Escape'&&menu.classList.contains('open')){e.stopPropagation();closeMenu(true);}});
  window.addEventListener('beforeunload',function(){cancelAnimationFrame(raf);});
  sync();
})();