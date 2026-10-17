/* The endpoint is configured per device. Never put device codes/topics in Git. */
(function () {
  'use strict';
  const STORAGE = 'pair_ntfy_device_v1';
  let settings = {}, bridge = null, frame = null, readyPromise = null, channel;
  const pending = new Map();
  try { settings = JSON.parse(localStorage.getItem(STORAGE) || '{}'); } catch (_) {}
  function randomId() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join(''); }
  function resetBridge() {
    if (frame) frame.remove();
    frame = bridge = readyPromise = null;
    pending.forEach(p => {clearTimeout(p.timer);p.reject(Error('接続設定が変更されました。'));}); pending.clear();
  }
  function connect() {
    if (!settings.endpoint || !settings.token) return Promise.reject(Error('設定から「通知設定」を開き、端末を登録してください。'));
    if (readyPromise) return readyPromise;
    channel = randomId();
    readyPromise = new Promise((resolve,reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message',onReady);resetBridge();reject(Error('通知サーバーに接続できません。設定と通信状態を確認してください。')); },20000);
      function onReady(e) {
        if (!e.data || e.data.type !== 'pair-ready' || e.data.channel !== channel || !/^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/.test(e.origin)) return;
        clearTimeout(timer);window.removeEventListener('message',onReady);
        bridge = {source:e.source,origin:e.origin};resolve();
      }
      window.addEventListener('message',onReady);
      frame = document.createElement('iframe');frame.hidden = true;frame.title = '通知接続';
      frame.src = settings.endpoint + '?channel=' + channel;document.body.append(frame);
    });
    return readyPromise;
  }
  window.addEventListener('message', e => {
    const d=e.data;
    if (!bridge || e.source!==bridge.source || e.origin!==bridge.origin || !d || d.channel!==channel || d.type!=='pair-response') return;
    const p=pending.get(d.id); if(!p)return;
    pending.delete(d.id);clearTimeout(p.timer);
    if(d.ok)p.resolve(d.value);else p.reject(Error(d.error || '通知に失敗しました。'));
  });
  async function request(action,data={}) {
    await connect();const id=randomId();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(Error('応答を確認できませんでした。処理が済んでいる可能性があります。接続後に再確認してください。'));},25000);
      pending.set(id,{resolve,reject,timer});
      bridge.source.postMessage({type:'pair-request',channel,id,request:{...data,action,token:settings.token}},bridge.origin);
    });
  }
  async function authenticated() {
    const status=await request('status');
    // config A/B is a display preference, never a substitute for server authentication.
    if(typeof config!=='undefined' && config.deviceUser!==status.member) throw Error('選択中の利用者と登録端末が異なります。設定の利用者を確認してください。');
    return status;
  }
  let sending=false, returnId=null;
  async function sendReturning() {
    if(sending)throw Error('送信中です。');sending=true;
    try {
      await authenticated();returnId=returnId || randomId();
      const result=await request('return',{requestId:returnId});returnId=null;return result;
    } finally {sending=false;}
  }
  async function saveReminder(id,data) {
    await authenticated();
    return request('save',{id,remindAt:data.remindAt,target:data.remindTarget || 'both'});
  }
  async function cancelReminder(id) {await authenticated();return request('cancel',{id});}
  function openSettings() {
    let dialog=document.getElementById('notification-dialog');
    if(dialog){dialog.showModal();return;}
    dialog=document.createElement('dialog');dialog.id='notification-dialog';
    dialog.style.cssText='margin:auto;border:1px solid #e2e8f0;border-radius:18px;padding:22px;width:min(94vw,440px);max-height:90vh;color:#1e293b';
    dialog.innerHTML='<form method="dialog"><h2 style="font-size:19px;margin-bottom:12px">通知設定</h2><p style="font-size:13px;margin-bottom:14px">2人のスマホにntfyを入れ、この端末の通知先を登録します。登録コードや通知先は他の人に共有しないでください。</p><label>通知サーバーURL<input id="notify-endpoint" class="form-input" type="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec"></label><label>この端末の登録コード<input id="notify-token" class="form-input" type="password" autocomplete="off"></label><button type="button" id="notify-connect" class="btn primary" style="margin:14px 0">接続して登録</button><p id="notify-status" role="status" style="font-size:13px;white-space:pre-wrap"></p><label id="notify-topic-label" hidden>ntfyで登録する通知先<input id="notify-topic" class="form-input" readonly></label><p style="font-size:12px;margin:12px 0">メモ通知は数分遅れる場合があります。無料の通知先は、名前を知る人が閲覧・投稿できます。ランダムな通知先を使い、メモ本文は通知しません。</p><button class="btn secondary">閉じる</button></form>';
    document.body.append(dialog);
    dialog.querySelector('#notify-endpoint').value=settings.endpoint || 'https://script.google.com/macros/s/AKfycbwEpf-pDj3dmplQCkWvYzIppkDwlf6BXI-aICNfdsMqnJ5-S-3w-nxwP8azj7IxGCI/exec';
    dialog.querySelector('#notify-token').value=settings.token || '';
    dialog.querySelector('#notify-connect').onclick=async()=>{
      const button=dialog.querySelector('#notify-connect'),status=dialog.querySelector('#notify-status');
      const endpoint=dialog.querySelector('#notify-endpoint').value.trim(),token=dialog.querySelector('#notify-token').value.trim();
      if(!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(endpoint) || !/^[a-f0-9]{64}$/.test(token)){status.textContent='URLまたは登録コードを確認してください。';return;}
      const previous=settings;settings={endpoint,token};resetBridge();button.disabled=true;status.textContent='接続しています…';
      try {
        const result=await request('status');
        settings.member=result.member;localStorage.setItem(STORAGE,JSON.stringify(settings));
        dialog.querySelector('#notify-topic').value=result.topic;dialog.querySelector('#notify-topic-label').hidden=false;
        status.textContent='端末'+result.member+'として登録しました。\n'+(result.enabled?'ntfyに下の通知先を登録してください。':'通知サーバーは準備中です。有効化後に受信テストが必要です。');
      } catch(e){settings=previous;resetBridge();status.textContent=e.message;}finally{button.disabled=false;}
    };
    dialog.showModal();
  }
  window.PairNotify={saveReminder,cancelReminder,sendReturning,openSettings};
})();
