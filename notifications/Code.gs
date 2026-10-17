// Deploy as a NEW Apps Script project. Keep the previous LINE deployment intact.
// Script properties: ENABLED=false, APP_ORIGIN, STATE (see README).
function doGet(e) {
  var channel = e && e.parameter && e.parameter.channel;
  if (!/^[a-f0-9]{32}$/.test(channel || '')) return HtmlService.createHtmlOutput('ふたりノートの通知接続です。アプリから開いてください。');
  var origin = PropertiesService.getScriptProperties().getProperty('APP_ORIGIN');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin || '')) throw Error('接続先が未設定です。');
  var page = HtmlService.createTemplateFromFile('Bridge');
  page.channel = channel;
  page.origin = origin;
  return page.evaluate().setTitle('通知接続').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}
function locked_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw Error('処理中です。少し待って再試行してください。');
  try { return fn(PropertiesService.getScriptProperties()); } finally { lock.releaseLock(); }
}
function state_(p) {
  var s = JSON.parse(p.getProperty('STATE') || '{}');
  ['A','B'].forEach(function(m) {
    if (!s[m] || !/^[a-f0-9]{64}$/.test(s[m].deviceHash || '') || !/^fn-[a-f0-9]{48}$/.test(s[m].topic || '')) throw Error('通知先の設定が未完了です。');
  });
  if (s.A.deviceHash === s.B.deviceHash || s.A.topic === s.B.topic) throw Error('通知先を分けてください。');
  return s;
}
function identify_(s, token) {
  if (!/^[a-f0-9]{64}$/.test(token || '')) throw Error('端末登録コードを確認してください。');
  var digest = hash_(token);
  var members = ['A','B'].filter(function(m) { return s[m].deviceHash === digest; });
  if (members.length !== 1) throw Error('端末登録コードを確認してください。');
  return members[0];
}
function memoKey_(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw Error('メモIDが無効です。');
  return 'REMINDER_' + id;
}
function notificationRequest(request) {
  return locked_(function(p) {
    var s = state_(p), m = identify_(s, request && request.token), partner = m === 'A' ? 'B' : 'A';
    if (request.action === 'status') return {member:m, topic:s[m].topic, enabled:p.getProperty('ENABLED') === 'true'};
    if (request.action === 'cancel') {
      p.deleteProperty(memoKey_(request.id));
      return {cancelled:true};
    }
    if (p.getProperty('ENABLED') !== 'true') throw Error('通知は準備中です。');
    if (request.action === 'return') {
      if (!/^[a-f0-9]{32}$/.test(request.requestId || '')) throw Error('通知IDが無効です。');
      if (s[m].lastReturnId === request.requestId) return {accepted:true};
      if (Date.now() - (s[m].lastAttempt || 0) < 60000) throw Error('連続送信を防ぐため1分待ってください。');
      s[m].lastAttempt = Date.now();
      p.setProperty('STATE', JSON.stringify(s));
      send_(p, s[partner].topic, '帰宅連絡', 'パートナーが今から帰るよ、と知らせています。');
      s[m].lastReturnId = request.requestId;
      p.setProperty('STATE', JSON.stringify(s));
      return {accepted:true};
    }
    if (request.action === 'save') {
      var key = memoKey_(request.id), at = Date.parse(request.remindAt);
      if (!Number.isFinite(at) || at <= Date.now() || at > Date.now() + 366*86400000) throw Error('通知日時は未来の1年以内で指定してください。');
      if (['both','self','partner','A','B'].indexOf(request.target) < 0) throw Error('通知先が無効です。');
      var all = p.getProperties();
      if (!all[key] && Object.keys(all).filter(function(k){return k.indexOf('REMINDER_')===0;}).length >= 100) throw Error('予約は100件までです。');
      var recipients = request.target === 'both' ? ['A','B'] : [request.target === 'A' || request.target === 'B' ? request.target : request.target === 'self' ? m : partner];
      // No memo text or device/topic credentials in the reminder record or notification.
      p.setProperty(key, JSON.stringify({at:at, recipients:recipients, done:[], attempts:0, nextAttempt:0}));
      return {scheduled:true, at:new Date(at).toISOString()};
    }
    throw Error('未対応の操作です。');
  });
}
function send_(p, topic, title, message) {
  var day = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var budget = JSON.parse(p.getProperty('BUDGET') || '{}');
  if (budget.day !== day) budget = {day:day,count:0};
  if (budget.count >= 100) throw Error('本日の送信上限です。');
  budget.count++;
  p.setProperty('BUDGET', JSON.stringify(budget));
  var response = UrlFetchApp.fetch('https://ntfy.sh', {
    method:'post', contentType:'application/json', muteHttpExceptions:true,
    payload:JSON.stringify({topic:topic,title:title,message:message,click:p.getProperty('APP_ORIGIN')+'/futariapps/',tags:['house']})
  });
  if (response.getResponseCode() !== 200) throw Error('通知サービスが受け付けませんでした。時間をおいて再試行してください。');
}
function processReminders_() {
  return locked_(function(p) {
    if (p.getProperty('ENABLED') !== 'true') return;
    var s = state_(p), all = p.getProperties(), now = Date.now(), count = 0;
    Object.keys(all).filter(function(k){return k.indexOf('REMINDER_')===0;}).forEach(function(key) {
      var r = JSON.parse(all[key]);
      if (r.at > now || r.nextAttempt > now || count >= 10) return;
      // Expire very late reminders instead of delivering stale alerts indefinitely.
      if (now - r.at > 86400000 || r.attempts >= 8) { p.deleteProperty(key); return; }
      count++;
      for (var i=0;i<r.recipients.length;i++) {
        var recipient = r.recipients[i];
        if (r.done.indexOf(recipient) >= 0) continue;
        r.attempts++;
        try {
          send_(p, s[recipient].topic, 'メモのリマインド', '設定したメモの時刻になりました。ふたりノートを確認してください。');
          r.done.push(recipient);
          p.setProperty(key, JSON.stringify(r));
        } catch (_) {
          r.nextAttempt = now + 15*60000;
          p.setProperty(key, JSON.stringify(r));
          break;
        }
      }
      if (r.done.length === r.recipients.length) p.deleteProperty(key);
    });
  });
}
// Run manually in the Apps Script editor. Private functions cannot be called from the browser.
function installReminderTrigger_() {
  if (!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='processReminders_';}))
    ScriptApp.newTrigger('processReminders_').timeBased().everyMinutes(5).create();
}
