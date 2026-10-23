/* DsignX Ops — application script (loaded as an ES module so it runs after platform.js is ready). */
import './platform.js?v=2026-10-23.26';

(function(){
  "use strict";

  /* ============================ brand assets ============================ */

  /* ============================ constants ============================ */
  var CATEGORIES = [
    {key:'signage', label:'Signage', dot:'var(--dot-signage)'},
    {key:'printing', label:'Printing', dot:'var(--dot-printing)'},
    {key:'sublimation', label:'Sublimation', dot:'var(--dot-sublimation)'},
    {key:'design', label:'Design', dot:'var(--dot-design)'},
    {key:'other', label:'Other', dot:'var(--dot-other)'}
  ];
  var STATUSES = [
    {key:'new', label:'New'},
    {key:'quoted', label:'Quoted'},
    {key:'designing', label:'Designing'},
    {key:'approval', label:'Awaiting Approval'},
    {key:'printing', label:'Printing'},
    {key:'production', label:'Production'},
    {key:'invoiced', label:'Invoiced'},
    {key:'ready', label:'Ready'},
    {key:'collected', label:'Collected'}
  ];
  // Jobs saved under the old flow: "In Progress" starts at Designing, "Delivered" becomes Collected.
  var LEGACY_STATUS = {in_progress:'designing', delivered:'collected'};
  function normStatus(st){ return LEGACY_STATUS[st] || st; }
  var DONE_STATUSES = ['ready','collected'];        // work finished — not overdue
  var AFTER_INVOICE = ['invoiced','ready','collected'];
  var COLLECTED_SHOW_DAYS = 14;
  var SOURCES = ['WhatsApp','Phone call','Instagram DM','Walk-in','Email','Other'];
  var TEAM_ROLES = [
    {key:'designer', label:'Designer', plural:'Designers'},
    {key:'technician', label:'Technician', plural:'Technicians'}
  ];
  function roleLabel(k){ for(var i=0;i<TEAM_ROLES.length;i++){ if(TEAM_ROLES[i].key===k) return TEAM_ROLES[i].label; } return k; }
  function initials(name){
    var parts = String(name||'').trim().split(/\s+/);
    if(!parts[0]) return '?';
    return (parts[0][0] + (parts[1]?parts[1][0]:'')).toUpperCase();
  }
  var DEFAULT_TEMPLATE = "Hi DsignX! I'd like to order:\n\nItem / product:\nQuantity:\nSize / details:\nNeeded by (date):\nMy name:\nCollection or delivery:";

  function catMeta(k){ for(var i=0;i<CATEGORIES.length;i++){ if(CATEGORIES[i].key===k) return CATEGORIES[i]; } return CATEGORIES[4]; }
  function statusMeta(k){ if(k==='quote') return {key:'quote', label:'Quotation only'}; for(var i=0;i<STATUSES.length;i++){ if(STATUSES[i].key===k) return STATUSES[i]; } return STATUSES[0]; }

  /* ============================ state ============================ */
  var STATE = {
    tab:'dashboard',
    isLive:false,
    customers:[],
    orders:[],
    config:{
      businessName:'DsignX', whatsappNumber:'', messageTemplate:DEFAULT_TEMPLATE, accountCode:'200', taxType:'Output', currency:'ZAR',
      businessAddress:'', businessEmail:'', quoteValidityDays:14, vatRate:15,
      quoteTerms:'A 50% deposit is required before work begins, with the balance due on collection or delivery. Prices are valid for the period shown above and may change thereafter.',
      nextQuoteNumber:1,
      businessVatNumber:'', invoiceDueDays:7, nextInvoiceNumber:1,
      invoiceTerms:'Payment due within 7 days of invoice date via EFT, using the invoice number as reference.',
      bankName:'', bankAccountHolder:'', bankAccountNumber:'', bankBranchCode:'',
      appShareLink:''
    },
    quoteFilter:'all',
    customerQuery:'',
    boardQuery:'',
    openOrderId:null,
    newOrderOpen:false,
    newOrderPrefill:null,
    selectedForExport:{},
    db:null, assets:null, downloads:null,
    mcp:null,
    waStatus:'idle', waError:null, waConversations:[], waMessages:{}, waHandled:{}, waLastChecked:null, waLastInbound:{}, waUnwatch:null,
    chatMessages:{}, chatDraft:{},
    team:[], newTeamOpen:false, boardAssigneeFilter:'all',
    quoteModalOrderId:null, quoteDraft:null, waMediaCheck:null,
    invoiceModalOrderId:null, invoiceDraft:null,
    currentUserId:null,
    inviteMemberId:null, inviteDraftText:'', inviteCode:null,
    reportFrom:'', reportTo:'', reportOpenMember:null,
    invExportFrom:'', invExportTo:'', invExportStatus:'Draft',
    custExportFrom:'', custExportTo:'', custExportMode:'added',
    customerForm:null,
    products:[], productForm:null, productImport:null, productQuery:'',
    receipts:[], receiptForm:null, messages:[], msgForm:null, msgOpenId:null, msgBox:'inbox', msgShow:'open', msgDraft:'', creditNotes:[], creditForm:null, cnExFrom:'', cnExTo:'', cnExStatus:'Draft', ageAsAt:'', ageOpen:null, stocktakes:[], stockDraft:{}, stockQuery:'', cashups:{}, cashupDate:'', cashupForm:null, rxFrom:'', rxTo:'', rxMethod:'all',
    user:null, links:{},
    auth:{phase:'checking', uid:null, isOwner:false, memberId:null, role:null, error:'', busy:false, myAuth:null, myLink:null, teamLoaded:false, fails:0, lockUntil:0}
  };

  /* ============================ access control ============================ */
  // Who can open what. Owner = the account that completed first-time setup; everyone else must be
  // a team member who redeemed an invite code. The same rules are enforced in firestore.rules.
  var ROLE_TABS = {
    owner:      ['dashboard','board','messages','whatsapp','customers','team','quotes','products','cashup','reports','exports','settings'],
    designer:   ['dashboard','board','messages','whatsapp','customers','team','quotes','products','cashup','reports'],
    technician: ['board','messages']
  };
  var PASSWORD_ITER = 210000, CODE_ITER = 100000, CODE_TTL_DAYS = 7;
  var IDLE_LOCK_MS = 30*60*1000, SESSION_MS = 12*60*60*1000;

  function currentRole(){ return STATE.auth.role || null; }
  function isOwnerRole(){ return currentRole()==='owner'; }
  function isTechnician(){ return currentRole()==='technician'; }
  // Cash-ups: the owner, plus team members the owner has ticked on the Team tab.
  function canCashup(){ if(isOwnerRole()) return true; var m = currentTeamMember(); return !!(m && m.canCashup && m.active!==false); }
  function canAccess(tab){ if(tab==='cashup') return canCashup(); var r = currentRole(); return !!(r && ROLE_TABS[r] && ROLE_TABS[r].indexOf(tab)>=0); }
  function firstAllowedTab(){ var r = currentRole(); return (r && ROLE_TABS[r]) ? ROLE_TABS[r][0] : 'board'; }
  function currentTeamMember(){
    if(!STATE.currentUserId) return null;
    return STATE.team.find(function(m){ return m.id===STATE.currentUserId; }) || null;
  }

  /* ---- crypto helpers (PBKDF2-SHA256 via WebCrypto) ---- */
  function b64(buf){ var b = new Uint8Array(buf), s = ''; for(var i=0;i<b.length;i++){ s += String.fromCharCode(b[i]); } return btoa(s); }
  function unb64(str){ var s = atob(str), b = new Uint8Array(s.length); for(var i=0;i<s.length;i++){ b[i] = s.charCodeAt(i); } return b; }
  function randomSalt(){ var a = new Uint8Array(16); crypto.getRandomValues(a); return b64(a); }
  function pbkdf2(secret, saltB64, iterations){
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']).then(function(key){
      return crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:unb64(saltB64), iterations:iterations}, key, 256);
    }).then(b64);
  }
  var CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function generateInviteCode(){
    var a = new Uint8Array(8); crypto.getRandomValues(a);
    var c = ''; for(var i=0;i<8;i++){ c += CODE_ALPHABET[a[i] % CODE_ALPHABET.length]; }
    return c.slice(0,4) + '-' + c.slice(4);
  }
  function normalizeCode(c){ c = String(c||'').toUpperCase().replace(/[^A-Z0-9]/g,''); return c.length===8 ? c.slice(0,4)+'-'+c.slice(4) : c; }
  var _codeCache = {};
  function codeMatches(code, member){
    if(!code || !member || !member.inviteHash || !member.inviteSalt) return Promise.resolve(false);
    var k = code+'|'+member.inviteSalt+'|'+member.inviteHash;
    if(_codeCache[k]!==undefined) return Promise.resolve(_codeCache[k]);
    return pbkdf2(code, member.inviteSalt, member.inviteIter||CODE_ITER).then(function(h){ _codeCache[k] = (h===member.inviteHash); return _codeCache[k]; });
  }

  /* ---- signed-in session (Firebase Authentication, this browser tab only) ---- */
  var _lastActivity = Date.now();
  function noteActivity(){ _lastActivity = Date.now(); }
  ['click','keydown','pointerdown','scroll'].forEach(function(ev){ document.addEventListener(ev, noteActivity, true); });
  setInterval(function(){
    if(STATE.auth.phase==='unlocked' && Date.now()-_lastActivity > IDLE_LOCK_MS){ lockApp('Signed out after 30 minutes without activity.'); }
  }, 60000);

  // Signing out reloads the page so no business data stays in memory.
  function lockApp(msg){
    try{ if(msg) sessionStorage.setItem('dsx_signout_msg', msg); }catch(e){}
    STATE.auth.busy = true; render();
    window.DSX.auth.signOut().then(function(){ location.reload(); }, function(){ location.reload(); });
  }

  /* ---- deciding what this person may do ---- */
  var _unwatchLink = null, _unwatchMember = null;
  function onAuthUser(user){
    var A = STATE.auth;
    if(_unwatchLink){ _unwatchLink(); _unwatchLink = null; }
    if(_unwatchMember){ _unwatchMember(); _unwatchMember = null; }
    if(!user){
      if(A.phase==='unlocked'){ location.reload(); return; }
      A.uid = null; A.email = ''; A.role = null; A.memberId = null; A.isOwner = false;
      settle(A.mode==='join' ? 'join' : (A.mode==='setup' ? 'setup' : 'signin'));
      return;
    }
    A.uid = user.uid; A.email = user.email || '';
    if(A.phase!=='unlocked'){ A.phase = 'checking'; render(); }
    _unwatchLink = STATE.db.doc('links/'+user.uid).onSnapshot(function(snap){
      if(snap.exists){
        var link = snap.data();
        if(link.role==='owner'){
          A.isOwner = true; A.role = 'owner'; A.memberId = null; STATE.currentUserId = null;
          A.pendingCode = ''; A.busy = false; A.error = '';
          settle('unlocked');
          return;
        }
        watchMember(link.memberId);
        return;
      }
      // No link: access was never granted, or it has just been removed.
      if(A.phase==='unlocked'){ lockApp('Your access to DsignX Ops has been removed. Ask the owner if this is a mistake.'); return; }
      A.role = null; A.memberId = null;
      if(A.pendingCode){ var c = A.pendingCode; A.pendingCode = ''; redeemInviteCode(c); return; }
      window.DSX.ownerClaimable().then(function(ok){ A.busy = false; settle(ok ? 'claim-owner' : 'need-code'); },
                                        function(){ A.busy = false; settle('need-code'); });
    }, function(){ A.busy = false; settle('need-code'); });
  }

  // A team member's role comes from their team record, so changing it in Team applies at once.
  function watchMember(memberId){
    var A = STATE.auth;
    if(_unwatchMember){ _unwatchMember(); _unwatchMember = null; }
    _unwatchMember = STATE.db.doc('team/'+memberId).onSnapshot(function(snap){
      var m = snap.exists ? Object.assign({id:memberId}, snap.data()) : null;
      if(!m || m.active===false){
        if(A.phase==='unlocked'){ lockApp('Your access to DsignX Ops has been removed. Ask the owner if this is a mistake.'); return; }
        A.busy = false; settle('need-code'); return;
      }
      if(A.phase==='unlocked' && A.role && A.role!==m.role){ A.role = m.role; if(!canAccess(STATE.tab)) STATE.tab = firstAllowedTab(); render(); return; }
      A.role = m.role; A.memberId = m.id; STATE.currentUserId = m.id; A.isOwner = false;
      A.busy = false; A.error = '';
      settle('unlocked');
    }, function(){ A.busy = false; settle('need-code'); });
  }

  function settle(phase){
    var A = STATE.auth, was = A.phase;
    A.phase = phase;
    if(phase==='unlocked' && was!=='unlocked'){
      _lastActivity = Date.now();
      if(!canAccess(STATE.tab)){ STATE.tab = firstAllowedTab(); }
      if(A.memberId){ STATE.boardAssigneeFilter = A.memberId; }
      startDataFeeds();
    }
    render();
  }

  /* ---- sign-in actions ---- */
  function authBusy(on, err){ STATE.auth.busy = on; if(err!==undefined) STATE.auth.error = err; render(); }

  function authErrorText(e){
    var c = (e && e.code) || '';
    if(/invalid-credential|wrong-password|user-not-found|invalid-login/.test(c)) return 'Wrong email or password.';
    if(/too-many-requests/.test(c)) return 'Too many tries. Wait a few minutes and try again.';
    if(/invalid-email/.test(c)) return 'That email address doesn’t look right.';
    if(/weak-password/.test(c)) return 'Choose a stronger password (at least 8 characters).';
    if(/email-already-in-use/.test(c)) return 'An account with this email already exists. Sign in instead.';
    if(/network-request-failed/.test(c)) return 'No connection. Check your internet and try again.';
    if(/requires-recent-login/.test(c)) return 'For safety, sign out and sign in again, then change your password.';
    if(/user-disabled/.test(c)) return 'This account has been disabled.';
    return 'Something went wrong. Try again.';
  }

  function signIn(email, pw){
    email = String(email||'').trim();
    if(!email || !pw){ authBusy(false, 'Enter your email and password.'); return; }
    authBusy(true, '');
    window.DSX.auth.signIn(email, pw).catch(function(e){ authBusy(false, authErrorText(e)); });
  }

  // New account for a team member (with an invite code) or the owner's first setup.
  function createAccount(email, pw, pw2, code){
    var A = STATE.auth;
    email = String(email||'').trim();
    if(!email){ authBusy(false, 'Enter your email address.'); return; }
    if(String(pw).length < 8){ authBusy(false, 'Use at least 8 characters for your password.'); return; }
    if(pw!==pw2){ authBusy(false, 'The two passwords don’t match.'); return; }
    if(A.mode==='join'){
      code = normalizeCode(code);
      if(code.length!==9){ authBusy(false, 'Invite codes have 8 letters and numbers, like ABCD-2345.'); return; }
      A.pendingCode = code;
    }
    authBusy(true, '');
    window.DSX.auth.create(email, pw).catch(function(e){
      if(e && /email-already-in-use/.test(e.code||'')){
        // Already has an account (e.g. re-invited): sign in with the password they typed.
        return window.DSX.auth.signIn(email, pw).catch(function(e2){ A.pendingCode = ''; authBusy(false, authErrorText(e2)); });
      }
      A.pendingCode = '';
      authBusy(false, authErrorText(e));
    });
  }

  function redeemInviteCode(raw){
    var code = normalizeCode(raw);
    if(code.length!==9){ authBusy(false, 'Invite codes have 8 letters and numbers, like ABCD-2345.'); settle('need-code'); return; }
    authBusy(true, '');
    window.DSX.call('redeemInvite', {code:code}).then(function(){
      // The link snapshot listener takes it from here.
    }).catch(function(e){
      STATE.auth.busy = false;
      STATE.auth.error = (e && e.message) ? e.message : 'That code isn’t valid. Check it, or ask the owner for a new one.';
      settle('need-code');
    });
  }

  function sendOwnerVerification(){
    authBusy(true, '');
    window.DSX.auth.sendVerification().then(function(){
      STATE.auth.verifySent = true; authBusy(false, '');
      toast('Verification email sent to '+STATE.auth.email);
    }).catch(function(e){ authBusy(false, authErrorText(e)); });
  }

  function claimOwner(){
    authBusy(true, '');
    window.DSX.auth.refresh().then(function(verified){
      if(!verified){ authBusy(false, 'Your email isn’t verified yet. Open the email we sent, click the link, then tap the button again.'); return; }
      return window.DSX.claimOwner().then(function(){});
    }).catch(function(){
      authBusy(false, 'Couldn’t set up the owner account. Check that you signed in with the owner email in firebase-config.js and firestore.rules.');
    });
  }

  function forgotPassword(email){
    email = String(email||'').trim();
    if(!email){ authBusy(false, 'Type your email address above first, then tap “Forgot password”.'); return; }
    authBusy(true, '');
    window.DSX.auth.reset(email).then(function(){
      authBusy(false, '');
      toast('If that email has an account, a reset link is on its way.');
    }).catch(function(e){ authBusy(false, authErrorText(e)); });
  }

  function setNewPassword(pw, pw2){
    if(String(pw).length < 8){ authBusy(false, 'Use at least 8 characters.'); return; }
    if(pw!==pw2){ authBusy(false, 'The two passwords don’t match.'); return; }
    authBusy(true, '');
    window.DSX.auth.updatePassword(pw).then(function(){
      STATE.auth.busy = false; STATE.auth.error = ''; STATE.auth.changing = false;
      settle('unlocked');
      toast('Password changed');
    }).catch(function(e){ authBusy(false, authErrorText(e)); });
  }

  function changePassword(){ STATE.auth.phase = 'set-password'; STATE.auth.error = ''; STATE.auth.changing = true; render(); }

  /* ---- sign-in screens ---- */
  var LOCK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
  function renderAuthScreen(){
    var A = STATE.auth, member = currentTeamMember();
    var err = A.error ? '<div class="auth-error" role="alert">'+escapeHtml(A.error)+'</div>' : '';
    var dis = A.busy ? ' disabled' : '';
    var link = function(action, label){ return '<a href="#" data-auth-action="'+action+'">'+label+'</a>'; };
    var body;
    if(A.phase==='checking'){
      body = '<h1>Checking access…</h1><div class="sub">One moment.</div>';
    } else if(A.phase==='error'){
      body = '<h1>Can’t start</h1><div class="sub">'+escapeHtml(A.error||'DsignX Ops couldn’t connect. Check your internet connection and reload the page.')+'</div>';
    } else if(A.phase==='join' || A.phase==='setup'){
      var join = A.phase==='join';
      body = '<h1>'+(join ? 'Join DsignX Ops' : 'Owner setup')+'</h1><div class="sub">'+(join
          ? 'Create your account with your email, a password and the invite code the owner sent you.'
          : 'First-time setup only. Create the owner account with the owner email address.')+'</div>' + err +
        '<form data-auth="create">' +
          '<div class="field"><label for="authEmail">Email</label><input type="email" id="authEmail" autocomplete="email" value="'+escapeHtml(A.email||'')+'" autofocus></div>' +
          '<div class="field"><label for="authPw1">Password</label><input type="password" id="authPw1" autocomplete="new-password" minlength="8"><div class="hint">At least 8 characters.</div></div>' +
          '<div class="field"><label for="authPw2">Type it again</label><input type="password" id="authPw2" autocomplete="new-password"></div>' +
          (join ? '<div class="field"><label for="authCode">Invite code</label><input class="code" id="authCode" autocomplete="one-time-code" placeholder="ABCD-2345" maxlength="9"></div>' : '') +
          '<button class="btn btn-primary" type="submit"'+dis+'>'+(A.busy?'One moment…':(join?'Create account':'Create owner account'))+'</button>' +
        '</form>' +
        '<div class="hint" style="margin-top:12px;">Already have an account? '+link('to-signin','Sign in')+'</div>';
    } else if(A.phase==='need-code'){
      body = '<h1>Enter your invite code</h1><div class="sub">You’re signed in as <strong>'+escapeHtml(A.email)+'</strong>, but this account hasn’t been given access yet. Type the code the owner sent you.</div>' + err +
        '<form data-auth="code"><div class="field"><label for="authCode">Invite code</label><input class="code" id="authCode" autocomplete="one-time-code" placeholder="ABCD-2345" maxlength="9" autofocus></div>' +
        '<button class="btn btn-primary" type="submit"'+dis+'>'+(A.busy?'Checking…':'Continue')+'</button></form>' +
        '<div class="hint" style="margin-top:12px;">'+link('sign-out','Sign out')+'</div>';
    } else if(A.phase==='claim-owner' && !window.DSX.auth.emailVerified()){
      body = '<h1>Verify your email</h1><div class="sub">To protect the owner account, confirm that <strong>'+escapeHtml(A.email)+'</strong> is yours. '+(A.verifySent?'We sent you an email with a link. Click it, then come back here.':'Tap the button to get a verification email.')+'</div>' + err +
        (A.verifySent
          ? '<button class="btn btn-primary" type="button" data-auth-action="claim-owner"'+dis+'>'+(A.busy?'Checking…':'I’ve clicked the link — continue')+'</button>' +
            '<div class="hint" style="margin-top:10px;">No email? Check your spam folder, or '+link('send-verify','send it again')+'.</div>'
          : '<button class="btn btn-primary" type="button" data-auth-action="send-verify"'+dis+'>'+(A.busy?'Sending…':'Send verification email')+'</button>') +
        '<div class="hint" style="margin-top:12px;">'+link('sign-out','Sign out')+'</div>';
    } else if(A.phase==='claim-owner'){
      body = '<h1>Set up DsignX Ops</h1><div class="sub">No owner has been set up yet. Signed in as <strong>'+escapeHtml(A.email)+'</strong>. Make this account the owner? This can only be done once.</div>' + err +
        '<button class="btn btn-primary" type="button" data-auth-action="claim-owner"'+dis+'>'+(A.busy?'Setting up…':'Make me the owner')+'</button>' +
        '<div class="hint" style="margin-top:12px;">'+link('sign-out','Sign out')+'</div>';
    } else if(A.phase==='set-password'){
      var who = A.role==='owner' ? 'Owner' : (member ? member.name : '');
      body = '<h1>Change your password</h1><div class="sub">'+(who?('Signed in as <strong>'+escapeHtml(who)+'</strong>. '):'')+'Choose a new password for '+escapeHtml(A.email)+'.</div>' + err +
        '<form data-auth="setpw"><div class="field"><label for="authPw1">New password</label><input type="password" id="authPw1" autocomplete="new-password" minlength="8" autofocus><div class="hint">At least 8 characters.</div></div>' +
        '<div class="field"><label for="authPw2">Type it again</label><input type="password" id="authPw2" autocomplete="new-password"></div>' +
        '<button class="btn btn-primary" type="submit"'+dis+'>'+(A.busy?'Saving…':'Save password')+'</button>' +
        '<button class="btn btn-ghost" type="button" data-auth-action="cancel-change">Cancel</button></form>';
    } else { // signin
      body = '<h1>Sign in</h1><div class="sub">DsignX Ops is for invited team members only.</div>' + err +
        '<form data-auth="signin">' +
          '<div class="field"><label for="authEmail">Email</label><input type="email" id="authEmail" autocomplete="email" value="'+escapeHtml(A.email||'')+'" autofocus></div>' +
          '<div class="field"><label for="authPw">Password</label><input type="password" id="authPw" autocomplete="current-password"></div>' +
          '<button class="btn btn-primary" type="submit"'+dis+'>'+(A.busy?'Signing in…':'Sign in')+'</button>' +
        '</form>' +
        '<div class="hint" style="margin-top:12px; line-height:1.9;">'+link('forgot','Forgot password?')+'<br>New team member? '+link('to-join','I have an invite code')+'<br>'+link('to-setup','First-time owner setup')+'</div>';
    }
    return '<div class="auth-wrap"><div class="auth-card">' +
      '<div class="brand"><div class="brand-mark"><img src="'+LOGO_MARK_DATA_URL+'" alt="DsignX"></div><div class="brand-text"><div class="tag">Ops</div></div></div>' +
      body +
      '<div class="auth-foot">'+LOCK_ICON+'Private workspace &middot; invited team members only</div>' +
    '</div></div>';
  }
  function bindAuthEvents(){
    var app = document.getElementById('app');
    var A = STATE.auth;
    app.onclick = function(e){
      var el = e.target.closest('[data-auth-action]');
      if(!el) return;
      e.preventDefault();
      var act = el.getAttribute('data-auth-action');
      var emailEl = document.getElementById('authEmail');
      if(emailEl) A.email = emailEl.value.trim();
      if(act==='cancel-change'){ A.changing = false; A.error=''; settle('unlocked'); }
      else if(act==='to-join'){ A.mode = 'join'; A.error = ''; settle('join'); }
      else if(act==='to-setup'){ A.mode = 'setup'; A.error = ''; settle('setup'); }
      else if(act==='to-signin'){ A.mode = ''; A.error = ''; settle('signin'); }
      else if(act==='forgot'){ forgotPassword(A.email); }
      else if(act==='claim-owner'){ if(!A.busy) claimOwner(); }
      else if(act==='send-verify'){ if(!A.busy) sendOwnerVerification(); }
      else if(act==='sign-out'){ lockApp(''); }
    };
    app.onchange = null; app.oninput = null;
    app.onsubmit = function(e){
      e.preventDefault();
      var f = e.target.getAttribute('data-auth');
      if(A.busy) return;
      var v = function(id){ var el = document.getElementById(id); return el ? el.value : ''; };
      if(f==='signin'){ A.email = v('authEmail').trim(); signIn(A.email, v('authPw')); }
      else if(f==='create'){ A.email = v('authEmail').trim(); createAccount(A.email, v('authPw1'), v('authPw2'), v('authCode')); }
      else if(f==='code'){ redeemInviteCode(v('authCode')); }
      else if(f==='setpw'){ setNewPassword(v('authPw1'), v('authPw2')); }
    };
    var af = app.querySelector('[autofocus]'); if(af){ try{ af.focus(); }catch(err){} }
  }

  // Digits only, in international form: South African local numbers (0xx xxx xxxx)
  // become 27xxxxxxxxx so WhatsApp gets a valid E.164 number.
  function waPhone(p){
    var d = String(p||'').replace(/\D/g,'');
    if(/^0\d{9}$/.test(d)) d = '27'+d.slice(1);
    if(/^270\d{9}$/.test(d)) d = '27'+d.slice(3);
    return d;
  }
  function currentChatPhone(){
    var o = STATE.orders.find(function(x){ return x.id===STATE.openOrderId; });
    if(o) return waPhone(o.phone);
    return (STATE.tab==='whatsapp' && STATE.inboxReply) ? STATE.inboxReply.phone : null;
  }
  // A stand-in "job" for an inbox conversation, so the customer chat box can be reused.
  function inboxContact(phone, name){
    var cust = STATE.customers.find(function(c){ return waPhone(c.phone)===phone; });
    return {id:'', inbox:true, phone:phone, customerId:cust ? cust.id : null,
      customerName:(cust && cust.name) || name || ('+'+phone), title:''};
  }

  function uid(){ return 'l' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

  /* ============================ sample data (shown only when db is unavailable) ============================ */
  function seedSample(){
    var today = new Date();
    function iso(daysFromNow){ var d = new Date(today); d.setDate(d.getDate()+daysFromNow); return d.toISOString().slice(0,10); }
    STATE.customers = [
      {id:'c1', name:'Riaan Pretorius', phone:'+27821234567', email:'', notes:'Regular — owns the tyre shop on Reitz Rd.', createdAt:iso(-40)},
      {id:'c2', name:'Kroonstad Primary School', phone:'+27827654321', email:'admin@kpschool.example', notes:'Orders sports day banners every term.', createdAt:iso(-90)},
      {id:'c3', name:'Lindiwe Mokoena', phone:'+27835558899', email:'', notes:'', createdAt:iso(-5)}
    ];
    STATE.orders = [
      {id:'o1', customerId:'c1', customerName:'Riaan Pretorius', phone:'+27821234567', category:'signage', title:'Shopfront fascia sign', description:'3m x 0.6m light box fascia, existing logo file', qty:1, status:'designing', quoteAmount:4200, invoiced:false, invoiceNumber:'', dueDate:iso(3), notes:'Confirm bracket colour with Riaan.', source:'WhatsApp', attachmentIds:[], designerId:'t1', designerName:'Thabo Nkosi', technicianId:'t2', technicianName:'Sipho Mahlangu', createdAt:iso(-6), updatedAt:iso(-1)},
      {id:'o2', customerId:'c2', customerName:'Kroonstad Primary School', phone:'+27827654321', category:'printing', title:'Sports day banners x6', description:'A1 PVC banners, house colours, eyelets', qty:6, status:'quoted', quoteAmount:2350, invoiced:false, invoiceNumber:'', dueDate:iso(8), notes:'', source:'Email', attachmentIds:[], designerId:'t3', designerName:'Naledi Dlamini', technicianId:null, technicianName:'', createdAt:iso(-3), updatedAt:iso(-2)},
      {id:'o3', customerId:'c3', customerName:'Lindiwe Mokoena', phone:'+27835558899', category:'sublimation', title:'Mug set — 12x sublimated mugs', description:'Family reunion design, proof already approved', qty:12, status:'ready', quoteAmount:960, invoiced:false, invoiceNumber:'', dueDate:iso(1), notes:'Collecting Friday afternoon.', source:'WhatsApp', attachmentIds:[], designerId:null, designerName:'', technicianId:'t4', technicianName:'Johan van Wyk', createdAt:iso(-4), updatedAt:iso(0)},
      {id:'o4', customerId:'c1', customerName:'Riaan Pretorius', phone:'+27821234567', category:'design', title:'New logo refresh', description:'Vector cleanup of old logo for signage + socials', qty:1, status:'new', quoteAmount:null, invoiced:false, invoiceNumber:'', dueDate:'', notes:'', source:'WhatsApp', attachmentIds:[], designerId:null, designerName:'', technicianId:null, technicianName:'', createdAt:iso(-1), updatedAt:iso(-1)},
      {id:'o5', customerId:'c2', customerName:'Kroonstad Primary School', phone:'+27827654321', category:'printing', title:'Prize-giving certificates x40', description:'A4 certificates, printed on card', qty:40, status:'collected', quoteAmount:680, invoiced:false, invoiceNumber:'', dueDate:iso(-2), notes:'', source:'Phone call', attachmentIds:[], designerId:'t1', designerName:'Thabo Nkosi', technicianId:'t2', technicianName:'Sipho Mahlangu', createdAt:iso(-14), updatedAt:iso(-2)},
      {id:'o6', customerId:'c3', customerName:'Lindiwe Mokoena', phone:'+27835558899', category:'sublimation', title:'Anniversary photo canvas', description:'40x60cm stretched canvas print', qty:1, status:'invoiced', quoteAmount:550, invoiced:true, invoiceNumber:'DSX-1042', dueDate:iso(-10), notes:'', source:'Instagram DM', attachmentIds:[], designerId:null, designerName:'', technicianId:'t4', technicianName:'Johan van Wyk', createdAt:iso(-20), updatedAt:iso(-9)}
    ];
    STATE.team = [
      {id:'t1', name:'Thabo Nkosi', role:'designer', phone:'+27831112222', email:'', invited:true, invitedAt:iso(-40), createdAt:iso(-120)},
      {id:'t3', name:'Naledi Dlamini', role:'designer', phone:'', email:'', invited:false, invitedAt:null, createdAt:iso(-60)},
      {id:'t2', name:'Sipho Mahlangu', role:'technician', phone:'+27834445555', email:'', invited:true, invitedAt:iso(-40), createdAt:iso(-120)},
      {id:'t4', name:'Johan van Wyk', role:'technician', phone:'', email:'', invited:false, invitedAt:null, createdAt:iso(-30)}
    ];
    STATE.config.whatsappNumber = '27821112222';
  }

  /* ============================ formatting ============================ */
  function money(n){
    if(n===null || n===undefined || n==='') return '—';
    try{ return new Intl.NumberFormat('en-ZA',{style:'currency',currency:STATE.config.currency||'ZAR',maximumFractionDigits:2}).format(n); }
    catch(e){ return 'R ' + Number(n).toFixed(2); }
  }
  function shortDate(iso){
    if(!iso) return '—';
    var d = new Date(iso+'T00:00:00');
    if(isNaN(d)) return iso;
    return d.toLocaleDateString('en-ZA',{day:'2-digit',month:'short'});
  }
  function fullDate(iso){
    if(!iso) return '—';
    var d = new Date(iso+'T00:00:00');
    if(isNaN(d)) return iso;
    return d.toLocaleDateString('en-ZA',{day:'2-digit',month:'short',year:'numeric'});
  }
  function localIso(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function todayIso(){ return localIso(new Date()); }
  function daysUntil(iso){
    if(!iso) return null;
    var d = new Date(iso+'T00:00:00'), t = new Date(todayIso()+'T00:00:00');
    return Math.round((d-t)/86400000);
  }
  function jobNo(id){
    var o = STATE.orders.find(function(x){ return x.id===id; });
    if(o && o.jobNumber) return o.jobNumber;
    return 'DSX-' + String(id).replace(/[^a-zA-Z0-9]/g,'').slice(-5).toUpperCase();
  }
  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function toast(msg){
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._h);
    toast._h = setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }

  /* ============================ data access layer ============================ */
  function ordersActive(){ return STATE.orders.filter(function(o){ return o.status!=='collected' && !o.quoteOnly; }); }

  function findCustomerByName(name){
    var n = name.trim().toLowerCase();
    for(var i=0;i<STATE.customers.length;i++){
      if(STATE.customers[i].name.trim().toLowerCase()===n) return STATE.customers[i];
    }
    return null;
  }

  function addCustomerLocal(data){
    var c = {id:uid(), name:data.name, phone:data.phone||'', email:data.email||'', notes:data.notes||'', createdAt:todayIso()};
    STATE.customers.unshift(c);
    return c;
  }

  function persistCustomer(data){
    if(STATE.isLive && STATE.db){
      if(!data.createdAt){ data = Object.assign({}, data, {createdAt:todayIso()}); }
      return STATE.db.collection('customers').add(data).then(function(ref){
        var c = Object.assign({id:ref.id}, data);
        return c;
      });
    }
    return Promise.resolve(addCustomerLocal(data));
  }

  function updateCustomerRecord(id, data){
    var c = STATE.customers.find(function(x){ return x.id===id; });
    if(c) Object.assign(c, data);
    if(STATE.isLive && STATE.db){
      var rec = Object.assign({}, c||{}, data); delete rec.id;
      return STATE.db.collection('customers').doc(id).set(rec).then(function(){ return c; });
    }
    return Promise.resolve(c);
  }

  function persistOrder(data){
    if(STATE.isLive && STATE.db){
      return STATE.db.collection('orders').add(data).then(function(ref){
        return Object.assign({id:ref.id}, data);
      });
    }
    var o = Object.assign({id:uid()}, data);
    STATE.orders.unshift(o);
    return Promise.resolve(o);
  }

  function updateOrder(id, patch){
    patch = Object.assign({}, patch, {updatedAt:todayIso()});
    var before = STATE.orders.find(function(x){ return x.id===id; });
    if(before && !before.invoicedAt && !before.invoiced && (patch.invoiced===true || patch.status==='invoiced')){ patch.invoicedAt = todayIso(); }
    if(before && patch.status==='collected' && before.status!=='collected'){ patch.collectedAt = todayIso(); }
    if(STATE.isLive && STATE.db){
      return STATE.db.collection('orders').doc(id).update(patch).then(function(){
        var o = STATE.orders.find(function(x){return x.id===id;});
        if(o) Object.assign(o, patch);
        render();
      }).catch(function(e){ toast('Could not save — try again'); });
    }
    var o = STATE.orders.find(function(x){return x.id===id;});
    if(o) Object.assign(o, patch);
    render();
    return Promise.resolve();
  }

  function deleteOrder(id){
    if(STATE.isLive && STATE.db){
      STATE.db.collection('orders').doc(id).delete().catch(function(){ toast('Could not delete — try again'); });
    }
    STATE.orders = STATE.orders.filter(function(x){return x.id!==id;});
    STATE.openOrderId = null;
    render();
  }

  function persistTeamMember(data){
    if(STATE.isLive && STATE.db){
      return STATE.db.collection('team').add(data).then(function(ref){
        return Object.assign({id:ref.id}, data);
      });
    }
    var m = Object.assign({id:uid()}, data);
    STATE.team.unshift(m);
    return Promise.resolve(m);
  }

  function deleteTeamMember(id){
    if(STATE.isLive && STATE.db){
      STATE.db.collection('team').doc(id).delete().catch(function(){ toast('Could not remove — try again'); });
      linksFor(id).forEach(function(uid){ STATE.db.doc('links/'+uid).delete().catch(function(){}); });
    }
    STATE.team = STATE.team.filter(function(x){ return x.id!==id; });
    render();
  }

  /* ============================ team invites ============================ */
  function inviteMessageFor(m, code){
    var saved = (STATE.config.appShareLink||'').trim();
    var link = (saved && !/claude\.ai/.test(saved)) ? saved : (location.origin + location.pathname);
    var biz = STATE.config.businessName || 'DsignX';
    return 'Hi '+m.name+', you\'ve been added to '+biz+' Ops as a '+roleLabel(m.role).toLowerCase()+'. Open this link to get started:\n'+link+'\n\nYour invite code: '+(code||'(code)')+'\n(valid for '+CODE_TTL_DAYS+' days, only works for you — please don\'t share it)\n\nTap “I have an invite code”, then enter your email address, choose a password and type the code. After that you just sign in with your email and password.';
  }

  function expiryIso(){ var d = new Date(); d.setDate(d.getDate()+CODE_TTL_DAYS); return d.toISOString().slice(0,10); }

  // Commits the code shown in the invite panel: stores only its salted hash. A new code replaces the
  // old one, which also signs out anyone who linked with the previous code.
  function markTeamInvited(id){
    var code = STATE.inviteCode;
    if(!code || !isOwnerRole()) return Promise.resolve();
    var salt = randomSalt();
    return pbkdf2(code, salt, CODE_ITER).then(function(hash){
      var patch = {invited:true, invitedAt:todayIso(), inviteHash:hash, inviteSalt:salt, inviteIter:CODE_ITER, inviteExpires:expiryIso(), active:true};
      var idx = STATE.team.findIndex(function(x){ return x.id===id; });
      if(idx>=0){ STATE.team[idx] = Object.assign({}, STATE.team[idx], patch); }
      if(STATE.isLive && STATE.db){
        // A new code replaces the old one and removes any account linked with an earlier code.
        return STATE.db.collection('team').doc(id).update(patch).then(function(){
          return Promise.all(linksFor(id).map(function(uid){ return STATE.db.doc('links/'+uid).delete().catch(function(){}); }));
        });
      }
    });
  }

  function linksFor(memberId){
    return Object.keys(STATE.links).filter(function(uid){ return STATE.links[uid] && STATE.links[uid].memberId===memberId; });
  }
  function revokeAccess(id){
    var m = STATE.team.find(function(x){ return x.id===id; });
    if(!m || !isOwnerRole()) return;
    var patch = {active:false, inviteHash:null, inviteSalt:null, inviteExpires:null};
    if(STATE.isLive && STATE.db){
      STATE.db.collection('team').doc(id).update(patch).catch(function(){ toast('Could not revoke — try again'); });
      linksFor(id).forEach(function(uid){ STATE.db.doc('links/'+uid).delete().catch(function(){}); });
    }
    Object.assign(m, patch);
    render();
    toast(m.name+' can no longer open DsignX Ops');
  }

  function sendTeamInvite(id){
    var m = STATE.team.find(function(x){ return x.id===id; });
    if(!m) return;
    var phone = waPhone(m.phone);
    if(!phone){ toast('Add a phone number for '+m.name+' first, or copy the invite message instead'); return; }
    if(!STATE.mcp){ toast('WhatsApp isn\'t connected right now — copy the invite message instead'); return; }
    var text = (STATE.inviteDraftText || inviteMessageFor(m, STATE.inviteCode)).trim();
    if(!text){ toast('Write an invite message first'); return; }
    if(STATE.inviteCode && text.indexOf(STATE.inviteCode)<0){ toast('Keep the invite code '+STATE.inviteCode+' in the message'); return; }
    markTeamInvited(id).then(function(){
      return waSendCall(phone, {text:{body:text}}, 'invite-'+id+'-'+(STATE.inviteCode||Date.now()));
    }).then(function(){
      STATE.inviteCode = null;
      STATE.inviteMemberId = null;
      STATE.inviteDraftText = '';
      render();
      toast('Invite sent to '+m.name+' via WhatsApp');
    }).catch(function(err){
      var n = waErrorNotice(err||{});
      toast('Could not send the invite — ' + n.text + (n.action?(' '+n.action):'') + ' You can copy the invite message instead.');
    });
  }

  function copyInviteMessage(id){
    var m = STATE.team.find(function(x){ return x.id===id; });
    if(!m) return;
    var text = (STATE.inviteDraftText || inviteMessageFor(m, STATE.inviteCode)).trim();
    if(!text){ toast('Write an invite message first'); return; }
    if(STATE.inviteCode && text.indexOf(STATE.inviteCode)<0){ toast('Keep the invite code '+STATE.inviteCode+' in the message'); return; }
    markTeamInvited(id).then(function(){
      copyText(text, 'Invite copied — the code is now active. Paste it into WhatsApp, email, or SMS');
      STATE.inviteCode = null;
      STATE.inviteMemberId = null;
      STATE.inviteDraftText = '';
      render();
    }).catch(function(){ toast('Could not save the invite code — try again'); });
  }

  function updateConfig(patch){
    STATE.config = Object.assign({}, STATE.config, patch);
    if(STATE.isLive && STATE.db){
      var cref = STATE.db.doc('config/business');
      (cref.merge ? cref.merge(patch) : cref.set(STATE.config)).catch(function(){});
    }
    render();
  }

  /* ---- line amounts: qty x unit price, less the line discount % ---- */
  function lineDiscPct(li){ var d = Number(li && li.discount); return isFinite(d) ? Math.min(100, Math.max(0, d)) : 0; }
  function lineGross(li){ return (Number(li.qty)||0) * (Number(li.unitPrice)||0); }
  function lineNet(li){ return Math.round(lineGross(li) * (1 - lineDiscPct(li)/100) * 100) / 100; }
  function linesDiscount(items){ return Math.round((items||[]).reduce(function(s,li){ return s + (lineGross(li) - lineNet(li)); }, 0) * 100) / 100; }

  /* ============================ quotations ============================ */
  function quoteTotals(draft){
    var subtotal = draft.items.reduce(function(s,li){ return s + lineNet(li); }, 0);
    var vat = draft.vatEnabled ? subtotal * (Number(STATE.config.vatRate)||0) / 100 : 0;
    return {subtotal:subtotal, vat:vat, total:subtotal+vat};
  }

  function openQuoteModal(orderId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!o) return;
    var items = (o.lineItems && o.lineItems.length) ? o.lineItems.map(function(li){ return Object.assign({}, li); }) : [{
      description: o.title || 'Job',
      qty: o.qty || 1,
      unitPrice: (o.quoteAmount!=null && o.qty) ? Number((o.quoteAmount/o.qty).toFixed(2)) : (o.quoteAmount || 0)
    }];
    STATE.quoteDraft = {
      items: items,
      terms: (o.quoteTerms!=null ? o.quoteTerms : STATE.config.quoteTerms) || '',
      validDays: o.quoteValidDays || STATE.config.quoteValidityDays || 14,
      vatEnabled: (o.quoteVatEnabled!=null ? !!o.quoteVatEnabled : true)
    };
    STATE.quoteModalOrderId = orderId;
    STATE.openOrderId = null;
    render();
  }

  function closeQuoteModal(){
    STATE.quoteModalOrderId = null;
    STATE.quoteDraft = null;
    render();
  }

  function addQuoteLine(){
    STATE.quoteDraft.items.push({description:'', qty:1, unitPrice:0});
    render();
  }
  function removeQuoteLine(i){
    STATE.quoteDraft.items.splice(i,1);
    if(!STATE.quoteDraft.items.length){ STATE.quoteDraft.items.push({description:'', qty:1, unitPrice:0}); }
    render();
  }

  function refreshQuoteTotals(){
    if(!STATE.quoteDraft) return;
    var t = quoteTotals(STATE.quoteDraft);
    STATE.quoteDraft.items.forEach(function(li, i){
      var el = document.getElementById('qliLineTotal-'+i);
      if(el) el.textContent = money(lineNet(li));
    });
    var sub = document.getElementById('qSubtotal'); if(sub) sub.textContent = money(t.subtotal);
    var vatRow = document.getElementById('qVatAmount'); if(vatRow) vatRow.textContent = money(t.vat);
    var tot = document.getElementById('qTotal'); if(tot) tot.textContent = money(t.total);
  }

  function ensureQuoteNumber(o){
    if(o.quoteNumber) return Promise.resolve(o.quoteNumber);
    return reserveNumbers('nextQuoteNumber', 1).then(function(n){
      var num = 'DSX-Q' + String(n).padStart(4,'0');
      return updateOrder(o.id, {quoteNumber:num}).then(function(){ return num; });
    });
  }

  function saveQuoteDraft(orderId, mode){
    // mode: false/'save' = just save; true/'download' = save + download PDF;
    // 'whatsapp' = save + download PDF + hand off to the customer chat compose box.
    if(mode===true) mode = 'download';
    if(!mode) mode = 'save';
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!o || !STATE.quoteDraft) return;
    var draft = STATE.quoteDraft;
    var totals = quoteTotals(draft);
    var patch = {
      lineItems: draft.items.map(function(li){ return {description:li.description||'', qty:Number(li.qty)||0, unitPrice:Number(li.unitPrice)||0, discount:lineDiscPct(li), note:String(li.note||'').trim()}; }),
      quoteAmount: totals.subtotal,
      quoteTerms: draft.terms,
      quoteValidDays: Number(draft.validDays)||14,
      quoteVatEnabled: !!draft.vatEnabled,
      quoteGeneratedAt: todayIso()
    };
    ensureQuoteNumber(o).then(function(num){
      return updateOrder(o.id, patch).then(function(){ return num; });
    }).then(function(num){
      var finalOrder = Object.assign({}, o, patch, {quoteNumber:num});
      if(mode==='whatsapp'){
        var built = buildQuotePdfBlob(finalOrder);
        closeQuoteModal();
        openQuoteWhatsappHandoff(finalOrder, built);
        return;
      }
      if(mode==='download'){ generateQuotePdf(finalOrder); }
      toast(mode==='download' ? 'Quote saved — downloading PDF' : 'Quote saved');
      closeQuoteModal();
    });
  }

  // After a quote is saved for WhatsApp, reopen the job's customer chat and stage the
  // PDF as a pending send — Cloudinary hosts it and Bird sends it, so
  // the person just reviews the preview and hits Send. Falls back to the older
  // download-and-attach-yourself flow if WhatsApp isn't connected on this view.
  function openQuoteWhatsappHandoff(o, built){
    var phone = waPhone(o.phone);
    STATE.openOrderId = o.id;
    if(!phone){
      toast('No phone number on file to message');
      render();
      return;
    }
    var totals = quoteTotals({items:o.lineItems||[], vatEnabled:o.quoteVatEnabled});
    var validUntil = addDays(o.quoteGeneratedAt || todayIso(), Number(o.quoteValidDays)||14);
    var caption = 'Hi '+(o.customerName||'there')+'! Your quotation '+(o.quoteNumber||'')+' for '+(o.title||'your job')+' comes to '+money(totals.total)+' (valid until '+fullDate(validUntil)+').';
    if(STATE.mcp && built){
      openOrderChat(phone);
      attachFileToChat(phone, built.blob, built.filename, 'application/pdf', caption);
    } else if(STATE.mcp){
      openOrderChat(phone);
      toast('Could not build the PDF — try again');
    } else {
      if(built){ if(STATE.downloads){ STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){ if(!err||err.code!=='declined'){ fallbackDownload(built.blob, built.filename); } }); } else { fallbackDownload(built.blob, built.filename); } }
      STATE.chatDraft[phone] = caption + ' I\'m attaching the PDF here now.';
      toast('Quote PDF downloading — attach it below and hit Send');
    }
    render();
  }

  // Builds the quote PDF and returns {blob, filename} — no side effects (no download,
  // no upload). generateQuotePdf() below wraps this for the "download to this device"
  // button; the WhatsApp send flow uses this directly to upload the blob to Cloudinary instead.
  function buildQuotePdfBlob(o){ return buildBrandedPdf('quote', o); }

  function generateQuotePdf(o){
    var built = buildQuotePdfBlob(o);
    if(!built) return;
    if(STATE.downloads){
      STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){
        if(err && err.code==='declined'){ return; }
        fallbackDownload(built.blob, built.filename);
      });
    } else {
      fallbackDownload(built.blob, built.filename);
    }
  }

  function fallbackDownload(blob, filename){
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ============================ branded quote / invoice PDF (DsignX Word templates) ============================ */
  var LETTERHEAD_DEFAULTS = {
    docCompanyName:'DSIGNX (PTY) LTD',
    docAddress:'36A Reitz Street, Central, Kroonstad, 9499',
    docTel:'056 004 0037',
    docWhatsapp:'060 083 3111',
    docEmail:'info@dsignx.co.za',
    docWebsite:'dsignx.co.za',
    docRegNo:'2025/197059/07',
    bankAccountType:'Business Account',
    bankSwift:'CABLZAJJ'
  };
  function lh(key){ var v = STATE.config[key]; return (v!=null && String(v).trim()!=='') ? String(v).trim() : (LETTERHEAD_DEFAULTS[key]||''); }
  function pdfNum(n){
    var v = (Math.round((Number(n)||0)*100)/100).toFixed(2).split('.');
    return v[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + v[1];
  }
  function pdfQty(n){ n = Number(n)||0; return (Math.round(n*100)/100).toFixed(2); }

  // kind: 'quote' | 'invoice'. Mirrors the layout of "DsignX Quote.docx" / "DsignX Invoice.docx".
  function buildBrandedPdf(kind, o){
    if(!window.jspdf || !window.jspdf.jsPDF){
      toast('PDF tools are still loading — try again in a moment');
      return null;
    }
    var isQuote = kind==='quote';
    var cfg = STATE.config;
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195, W = R - L;
    var MAROON = [78,9,40], INK = [43,43,43], GREY = [95,99,88], SAGE = [121,128,110], PANEL = [244,245,242], RULE = [222,222,216];
    function color(c){ doc.setTextColor(c[0],c[1],c[2]); }
    function font(style, size){ doc.setFont('helvetica', style); doc.setFontSize(size); }
    function spaced(txt, x, y, opts, cs){ doc.setCharSpace(cs==null?0.6:cs); doc.text(txt, x, y, opts||{}); doc.setCharSpace(0); }

    var vatNo = String(cfg.businessVatNumber||'').trim();
    var vatOn = isQuote ? (!!o.quoteVatEnabled && isVatVendor()) : (!!o.invoiceVatEnabled && isVatVendor());
    var rate = Number(cfg.vatRate)||15;
    var items = (isQuote ? o.lineItems : o.invoiceLineItems) || [];
    var totals = isQuote ? quoteTotals({items:items, vatEnabled:vatOn}) : invoiceTotals({items:items, vatEnabled:vatOn});
    var number = (isQuote ? o.quoteNumber : o.invoiceNumber) || '—';
    var issued = (isQuote ? o.quoteGeneratedAt : o.invoiceGeneratedAt) || todayIso();
    var until = isQuote ? addDays(issued, Number(o.quoteValidDays)||Number(cfg.quoteValidityDays)||14)
                        : addDays(issued, o.invoiceDueDays!=null ? Number(o.invoiceDueDays) : (Number(cfg.invoiceDueDays)||7));
    var title = isQuote ? 'QUOTE' : (isVatVendor() ? 'TAX INVOICE' : 'INVOICE');
    var currency = cfg.currency || 'ZAR';
    var cust = STATE.customers.find(function(c){ return c.id===o.customerId; }) || {};

    function footer(){
      doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.25); doc.line(L, 277, R, 277);
      font('bold', 8.5); color(MAROON); doc.text('Thank you for your business!', 105, 281.5, {align:'center'});
      font('normal', 6.8); color(GREY);
      var biz = /\(PTY\)\s*LTD/i.test(lh('docCompanyName')) ? ((cfg.businessName||'DsignX')+' (Pty) Ltd') : lh('docCompanyName');
      var l1 = [biz, 'Reg No '+lh('docRegNo')].concat(vatNo ? ['VAT No '+vatNo] : []).concat([lh('docAddress')]).join('  ·  ');
      var l2 = ['Tel '+lh('docTel'), 'WhatsApp '+lh('docWhatsapp'), lh('docEmail'), lh('docWebsite')].join('  ·  ');
      doc.text(l1, 105, 285, {align:'center'});
      doc.text(l2, 105, 288.3, {align:'center'});
    }

    /* ---- letterhead ---- */
    var logoW = 56, logoH = logoW * (358/800);
    doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 12, logoW, logoH);
    font('bold', 11.5); color(MAROON); spaced(lh('docCompanyName'), R, 18.5, {align:'right'}, 0.12);
    font('normal', 8.3); color(GREY);
    doc.text(lh('docAddress'), R, 23, {align:'right'});
    doc.text('Tel '+lh('docTel')+'   |   WhatsApp '+lh('docWhatsapp'), R, 27.2, {align:'right'});
    doc.text(lh('docEmail')+'   |   '+lh('docWebsite'), R, 31.4, {align:'right'});
    // "Reg No x | VAT No y" with bold labels, right-aligned
    var parts = [['Reg No ', lh('docRegNo')]].concat(vatNo ? [['   |   ',''],['VAT No ', vatNo]] : []);
    var widths = parts.map(function(p){ font('bold', 8.3); var a = doc.getTextWidth(p[0]); font('normal', 8.3); return a + doc.getTextWidth(p[1]); });
    var x = R - widths.reduce(function(a,b){ return a+b; }, 0);
    parts.forEach(function(p){
      var isSep = p[0].trim()==='|';
      font(isSep ? 'normal' : 'bold', 8.3); color(GREY); doc.text(p[0], x, 35.6); x += doc.getTextWidth(p[0]);
      font('normal', 8.3); doc.text(p[1], x, 35.6); x += doc.getTextWidth(p[1]);
    });
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 40.5, W, 0.9, 'F');

    /* ---- title + bill to ---- */
    font('bold', 25); color(MAROON); spaced(title, L, 55, null, 0.35);
    font('bold', 7.2); color(SAGE); spaced(isQuote ? 'QUOTE FOR' : 'BILL TO', L, 62, null, 0.6);
    font('bold', 10.5); color(INK); doc.text(o.customerName || cust.name || 'Customer', L, 67.5);
    font('normal', 8.8); color(GREY);
    var cy = 72;
    var billLines = [];
    if(personName(cust) && cust.type==='business') billLines.push('Attn: '+personName(cust));
    if(addrHasData(cust.postalAddress)) billLines = billLines.concat(formatAddress(cust.postalAddress).split('\n'));
    if(cust.vatNumber) billLines.push('VAT No: '+cust.vatNumber);
    billLines = billLines.concat([o.phone || cust.phone, cust.email]);
    billLines.filter(Boolean).forEach(function(line){
      doc.splitTextToSize(String(line), 95).forEach(function(t){ doc.text(t, L, cy); cy += 4.2; });
    });

    /* ---- info box ---- */
    var bx = 115.5, by = 46;
    var info = isQuote ?
      [['Quote Number', number, true], ['Date', fullDate(issued)], ['Valid Until', fullDate(until)], ['Reference', o.title||jobNo(o.id)]] :
      [['Invoice Number', number, true], ['Invoice Date', fullDate(issued)], ['Due Date', fullDate(until)], ['Reference', o.title||jobNo(o.id)]];
    var acct = (o.quoteOnly && !o.jobNumber) ? [] : [['Job Number', jobNo(o.id)]];
    if(String(o.poNumber||'').trim()) acct.push(['Customer PO', String(o.poNumber).trim()]);
    var boxH = 8 + info.length*4.7 + 2 + acct.length*4.7;
    doc.setFillColor(PANEL[0],PANEL[1],PANEL[2]); doc.rect(bx, by, R-bx, boxH, 'F');
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(bx, by, R-bx, 0.7, 'F');
    var iy = by + 6.2;
    info.forEach(function(r){
      font('bold', 8.3); color([140,140,132]); doc.text(r[0], bx+3, iy);
      font(r[2] ? 'bold' : 'normal', 8.6); color(INK);
      var v = doc.splitTextToSize(String(r[1]), 44)[0];
      doc.text(v, R-3, iy, {align:'right'}); iy += 4.7;
    });
    doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.2); doc.line(bx+3, iy-2.4, R-3, iy-2.4);
    iy += 2.2;
    acct.forEach(function(r){
      font('bold', 8.3); color([140,140,132]); doc.text(r[0], bx+3, iy);
      font('normal', 8.6); color(INK); doc.text(String(r[1]), R-3, iy, {align:'right'}); iy += 4.7;
    });

    var y = Math.max(cy, by + boxH) + 7;

    /* ---- quote title + summary ---- */
    if(isQuote){
      font('bold', 11); color(MAROON); doc.text(o.title || 'Quotation', L, y); y += 4.6;
      if(o.description){
        font('normal', 8.6); color(GREY);
        var sl = doc.splitTextToSize(o.description, W);
        doc.text(sl, L, y); y += sl.length*3.9;
      }
      y += 4;
    }

    /* ---- line items ---- */
    var C = {desc:L+2, qty:98, price:123, disc:142.5, tax:160, amt:R-1.5};
    function tableHead(){
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, W, 9.5, 'F');
      font('bold', 7.4); doc.setTextColor(255,255,255);
      spaced('DESCRIPTION', C.desc, y+5.9, null, 0.35);
      spaced('QTY', C.qty, y+5.9, {align:'right'}, 0.35);
      spaced('UNIT PRICE', C.price, y+5.9, {align:'right'}, 0.35);
      spaced('DISC %', C.disc, y+5.9, {align:'right'}, 0.35);
      spaced('VAT', C.tax, y+5.9, {align:'right'}, 0.35);
      spaced('AMOUNT', C.amt, y+4.3, {align:'right'}, 0.35);
      font('bold', 6.6); spaced(currency, C.amt, y+7.6, {align:'right'}, 0.35);
      y += 9.5 + 5;
    }
    tableHead();
    items.forEach(function(li){
      font('normal', 8.8);
      var dl = doc.splitTextToSize(String(li.description||''), 74);
      font('italic', 7.8);
      var nl = String(li.note||'').trim() ? doc.splitTextToSize(String(li.note).trim(), 74) : [];
      font('normal', 8.8);
      var rowH = Math.max(8, dl.length*4 + 4 + (nl.length ? nl.length*3.5 + 0.8 : 0));
      if(y + rowH > 262){ footer(); doc.addPage(); y = 18; tableHead(); }
      color(INK); doc.text(dl, C.desc, y);
      if(nl.length){ font('italic', 7.8); color(GREY); doc.text(nl, C.desc, y + dl.length*4 + 0.3); font('normal', 8.8); color(INK); }
      doc.text(pdfQty(li.qty), C.qty, y, {align:'right'});
      doc.text(pdfNum(li.unitPrice), C.price, y, {align:'right'});
      doc.text(lineDiscPct(li) ? pdfNum(lineDiscPct(li)) : '0.00', C.disc, y, {align:'right'});
      doc.text(vatOn ? (rate+'%') : 'No VAT', C.tax, y, {align:'right'});
      doc.text(pdfNum(lineNet(li)), C.amt, y, {align:'right'});
      y += rowH;
      doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.2); doc.line(L, y-4, R, y-4);
    });

    /* ---- totals ---- */
    if(y > 225){ footer(); doc.addPage(); y = 20; }
    var lx = 158, vx = R-1.5, band = 108.5;
    y += 2;
    font('normal', 8.8); color(GREY);
    doc.text('Subtotal', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(totals.subtotal), vx, y, {align:'right'});
    if(vatOn){
      y += 6; color(GREY);
      doc.text('Total VAT '+rate+'%', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(totals.vat), vx, y, {align:'right'});
    }
    y += 3.5;
    if(isQuote){
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(band, y, R-band, 11, 'F');
      font('bold', 11); doc.setTextColor(255,255,255);
      spaced('TOTAL '+currency, lx, y+7, {align:'right'}, 0.15);
      doc.text(pdfNum(totals.total), vx, y+7, {align:'right'});
      y += 11 + 5;
    } else {
      doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.3); doc.line(band, y, R, y);
      y += 5.5;
      font('bold', 9.5); color(MAROON); doc.text('Invoice Total '+currency, lx, y, {align:'right'}); doc.text(pdfNum(totals.total), vx, y, {align:'right'});
      y += 6.5;
      var paidSoFar = o.id ? round2(orderPaid(o.id)) : 0;
      var creditSoFar = o.id ? orderCredited(o.id) : 0;
      if(creditSoFar){ font('normal', 8.8); color(GREY); doc.text('Less Credit Notes '+currency, lx, y, {align:'right'}); color(INK); doc.text(pdfNum(creditSoFar), vx, y, {align:'right'}); y += 6; paidSoFar = round2(paidSoFar + creditSoFar); }
      font('normal', 8.8); color(GREY); doc.text('Total Net Payments '+currency, lx, y, {align:'right'}); color(INK); doc.text(pdfNum(paidSoFar - creditSoFar), vx, y, {align:'right'});
      y += 3.5;
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(band, y, R-band, 11, 'F');
      font('bold', 11); doc.setTextColor(255,255,255);
      spaced('AMOUNT DUE '+currency, lx, y+7, {align:'right'}, 0.15);
      doc.text(pdfNum(Math.max(0, totals.total - paidSoFar)), vx, y+7, {align:'right'});
      y += 11 + 5;
    }
    font('bold', 8); color([140,140,132]);
    doc.text('Total Discount Given', lx, y, {align:'right'}); doc.text(pdfNum(linesDiscount(items)), vx, y, {align:'right'});
    y += 12;

    /* ---- banking + payment / terms ---- */
    var termsTxt = isQuote ? (o.quoteTerms || cfg.quoteTerms || '') : (o.invoiceTerms || cfg.invoiceTerms || '');
    font('normal', 8.6);
    var termLines = termsTxt ? doc.splitTextToSize(termsTxt, R - 110.6) : [];
    var bank = [
      ['Bank', cfg.bankName||'', false],
      ['Account Name', lh('docCompanyName'), true],
      ['Account Type', lh('bankAccountType'), false],
      ['Account Number', cfg.bankAccountNumber||'', true],
      ['Branch Code', cfg.bankBranchCode||'', false],
      ['SWIFT Code', lh('bankSwift'), false],
      ['Reference', number, true, true]
    ].filter(function(r){ return r[1]; });
    var bankH = 11 + bank.length*4.3 + 2;
    var rightH = 16 + termLines.length*3.9;
    var blockH = Math.max(bankH, rightH);
    if(y + blockH > 272){ footer(); doc.addPage(); y = 20; }
    doc.setFillColor(PANEL[0],PANEL[1],PANEL[2]); doc.rect(12.7, y, 101-12.7, bankH, 'F');
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(12.7, y, 1.2, bankH, 'F');
    font('bold', 7.6); color(MAROON); spaced('BANKING DETAILS', 17.3, y+5.5, null, 0.6);
    var ry = y + 11;
    bank.forEach(function(r){
      font('bold', 8.2); color([140,140,132]); doc.text(r[0], 17.3, ry);
      font(r[2] ? 'bold' : 'normal', 8.6); color(r[3] ? MAROON : INK); doc.text(String(r[1]), 48, ry); ry += 4.3;
    });
    doc.setDrawColor(140,140,132); doc.setLineWidth(0.5); doc.line(106.6, y, 106.6, y+blockH);
    var tx = 110.6;
    font('bold', 7.6); color(MAROON); spaced(isQuote ? 'TERMS' : 'PAYMENT', tx, y+5.5, null, 0.6);
    font('bold', 8.6); color(INK);
    doc.text(isQuote ? ('This quote is valid until '+fullDate(until)+'.') : ('Due Date: '+fullDate(until)), tx, y+11);
    var py = y + 16;
    if(!isQuote){
      font('normal', 8.4); color(GREY);
      var pay = doc.splitTextToSize('Please use your invoice number as the payment reference and send proof of payment to '+lh('docEmail')+'.', R - tx);
      doc.text(pay, tx, py); py += pay.length*3.9 + 2;
    }
    if(termLines.length){ font('normal', 8.4); color(GREY); doc.text(termLines, tx, py); }

    footer();
    var blob = doc.output('blob');
    var filename = (isQuote ? (o.quoteNumber||'dsignx-quote') : (o.invoiceNumber||'dsignx-invoice')) + '.pdf';
    return {blob:blob, filename:filename};
  }

  function addDays(iso, days){
    var d = new Date((iso||todayIso())+'T00:00:00');
    d.setDate(d.getDate()+(Number(days)||0));
    return localIso(d);
  }

  /* ============================ tax invoices ============================ */
  // A "Tax Invoice" (the words matter under South African VAT law) may only be issued by
  // a VAT-registered vendor with a VAT number on it — so we only offer VAT on the invoice,
  // and only call it a Tax Invoice, once a business VAT number is on file. Without one this
  // generates a plain Invoice instead, with no VAT line — never a fabricated VAT number.
  function isVatVendor(){ return !!(STATE.config.businessVatNumber && String(STATE.config.businessVatNumber).trim()); }

  function invoiceTotals(draft){
    var subtotal = draft.items.reduce(function(s,li){ return s + lineNet(li); }, 0);
    var vat = (draft.vatEnabled && isVatVendor()) ? subtotal * (Number(STATE.config.vatRate)||0) / 100 : 0;
    return {subtotal:subtotal, vat:vat, total:subtotal+vat};
  }

  function openInvoiceModal(orderId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!o) return;
    var source = (o.invoiceLineItems && o.invoiceLineItems.length) ? o.invoiceLineItems
      : (o.lineItems && o.lineItems.length) ? o.lineItems
      : null;
    var items = source ? source.map(function(li){ return Object.assign({}, li); }) : [{
      description: o.title || 'Job',
      qty: o.qty || 1,
      unitPrice: (o.quoteAmount!=null && o.qty) ? Number((o.quoteAmount/o.qty).toFixed(2)) : (o.quoteAmount || 0)
    }];
    STATE.invoiceDraft = {
      items: items,
      terms: (o.invoiceTerms!=null ? o.invoiceTerms : STATE.config.invoiceTerms) || '',
      dueDays: o.invoiceDueDays || STATE.config.invoiceDueDays || 7,
      vatEnabled: isVatVendor() ? (o.invoiceVatEnabled!=null ? !!o.invoiceVatEnabled : (o.quoteVatEnabled!=null ? !!o.quoteVatEnabled : true)) : false
    };
    STATE.invoiceModalOrderId = orderId;
    STATE.openOrderId = null;
    render();
  }

  function closeInvoiceModal(){
    STATE.invoiceModalOrderId = null;
    STATE.invoiceDraft = null;
    render();
  }

  function addInvoiceLine(){
    STATE.invoiceDraft.items.push({description:'', qty:1, unitPrice:0});
    render();
  }
  function removeInvoiceLine(i){
    STATE.invoiceDraft.items.splice(i,1);
    if(!STATE.invoiceDraft.items.length){ STATE.invoiceDraft.items.push({description:'', qty:1, unitPrice:0}); }
    render();
  }

  function refreshInvoiceTotals(){
    if(!STATE.invoiceDraft) return;
    var t = invoiceTotals(STATE.invoiceDraft);
    STATE.invoiceDraft.items.forEach(function(li, i){
      var el = document.getElementById('iliLineTotal-'+i);
      if(el) el.textContent = money(lineNet(li));
    });
    var sub = document.getElementById('iSubtotal'); if(sub) sub.textContent = money(t.subtotal);
    var vatRow = document.getElementById('iVatAmount'); if(vatRow) vatRow.textContent = money(t.vat);
    var tot = document.getElementById('iTotal'); if(tot) tot.textContent = money(t.total);
  }

  function ensureInvoiceNumber(o){
    if(o.invoiceNumber) return Promise.resolve(o.invoiceNumber);
    return reserveNumbers('nextInvoiceNumber', 1).then(function(n){
      var num = 'DSX-INV' + String(n).padStart(4,'0');
      return updateOrder(o.id, {invoiceNumber:num}).then(function(){ return num; });
    });
  }

  function saveInvoiceDraft(orderId, mode){
    if(mode===true) mode = 'download';
    if(!mode) mode = 'save';
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!o || !STATE.invoiceDraft) return;
    var draft = STATE.invoiceDraft;
    var vatEnabled = !!draft.vatEnabled && isVatVendor();
    var totals = invoiceTotals(draft);
    var patch = {
      invoiceLineItems: draft.items.map(function(li){ return {description:li.description||'', qty:Number(li.qty)||0, unitPrice:Number(li.unitPrice)||0, discount:lineDiscPct(li), note:String(li.note||'').trim()}; }),
      quoteAmount: totals.subtotal, // keep the job's headline amount (dashboard, Xero export) matching what was actually invoiced
      invoiceTerms: draft.terms,
      invoiceDueDays: Number(draft.dueDays)||7,
      invoiceVatEnabled: vatEnabled,
      invoiceGeneratedAt: todayIso(),
      invoiced: true,
      status: 'invoiced'
    };
    if(AFTER_INVOICE.indexOf(o.status)>=0) delete patch.status;
    ensureInvoiceNumber(o).then(function(num){
      return updateOrder(o.id, patch).then(function(){ STATE.stockNote = ''; return syncInvoiceStock(o.id, patch.invoiceLineItems); }).then(function(){ return num; });
    }).then(function(num){
      var finalOrder = Object.assign({}, o, patch, {invoiceNumber:num});
      if(mode==='whatsapp'){
        var built = buildInvoicePdfBlob(finalOrder);
        closeInvoiceModal();
        openInvoiceWhatsappHandoff(finalOrder, built);
        return;
      }
      if(mode==='download'){ generateInvoicePdf(finalOrder); }
      toast((mode==='download' ? 'Invoice saved — downloading PDF' : 'Invoice saved') + (STATE.stockNote ? ' · '+STATE.stockNote : ''));
      closeInvoiceModal();
    });
  }

  // Same real-send handoff used for quotes — see openQuoteWhatsappHandoff.
  function openInvoiceWhatsappHandoff(o, built){
    var phone = waPhone(o.phone);
    STATE.openOrderId = o.id;
    if(!phone){
      toast('No phone number on file to message');
      render();
      return;
    }
    var totals = invoiceTotals({items:o.invoiceLineItems||[], vatEnabled:o.invoiceVatEnabled});
    var dueDate = addDays(o.invoiceGeneratedAt || todayIso(), Number(o.invoiceDueDays)||7);
    var caption = 'Hi '+(o.customerName||'there')+'! Here\'s your invoice '+(o.invoiceNumber||'')+' for '+(o.title||'your job')+' — total '+money(totals.total)+', due '+fullDate(dueDate)+'.';
    if(STATE.mcp && built){
      openOrderChat(phone);
      attachFileToChat(phone, built.blob, built.filename, 'application/pdf', caption);
    } else if(STATE.mcp){
      openOrderChat(phone);
      toast('Could not build the PDF — try again');
    } else {
      if(built){ if(STATE.downloads){ STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){ if(!err||err.code!=='declined'){ fallbackDownload(built.blob, built.filename); } }); } else { fallbackDownload(built.blob, built.filename); } }
      STATE.chatDraft[phone] = caption + ' I\'m attaching the PDF here now.';
      toast('Invoice PDF downloading — attach it below and hit Send');
    }
    render();
  }

  // See buildQuotePdfBlob — same split: this builds the blob with no side effects,
  // generateInvoicePdf() wraps it for the download button.
  function buildInvoicePdfBlob(o){ return buildBrandedPdf('invoice', o); }

  function generateInvoicePdf(o){
    var built = buildInvoicePdfBlob(o);
    if(!built) return;
    if(STATE.downloads){
      STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){
        if(err && err.code==='declined'){ return; }
        fallbackDownload(built.blob, built.filename);
      });
    } else {
      fallbackDownload(built.blob, built.filename);
    }
  }

  /* ============================ init / live wiring ============================ */
  function init(){
    seedSample();
    var P = window.DSX;
    if(!P || !P.configured){
      // Firebase isn't configured (or this browser can't run it): sample data only.
      STATE.auth.phase = 'demo'; STATE.auth.role = 'owner';
      STATE.demoReason = P && P.error ? P.error : 'Firebase isn’t configured yet (see js/firebase-config.js).';
      render();
      return;
    }
    STATE.db = P.db;
    STATE.isLive = true;
    STATE.customers = [];
    STATE.orders = [];
    STATE.team = [];
    STATE.auth.phase = 'checking';
    try{
      var msg = sessionStorage.getItem('dsx_signout_msg');
      if(msg){ STATE.auth.error = msg; sessionStorage.removeItem('dsx_signout_msg'); }
    }catch(e){}
    render();
    P.auth.onChange(onAuthUser);
  }

  // Business data only loads after sign-in, and only what the person's role may read.
  var _feedsStarted = false, _cashFeedsStarted = false, _statusBackfillDone = false;
  function startCashupFeeds(){
    if(_cashFeedsStarted || !STATE.db) return;
    _cashFeedsStarted = true;
    STATE.db.collection('receipts').onSnapshot(function(qs){
      STATE.receipts = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      render();
    }, function(){});
    STATE.db.collection('cashups').onSnapshot(function(qs){
      var m = {}; qs.docs.forEach(function(d){ m[d.id] = d.data(); });
      STATE.cashups = m;
      render();
    }, function(){});
    if(!STATE.downloads && window.DSX) STATE.downloads = window.DSX.downloads;
  }
  function startDataFeeds(){
    if(_feedsStarted || !STATE.db) return;
    _feedsStarted = true;
    var db = STATE.db;
    var A = STATE.auth;
    db.collection('team').orderBy('name').onSnapshot(function(qs){
      STATE.team = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      if(isTechnician() && canCashup()) startCashupFeeds();
      render();
    }, function(){});
    if(A.role==='owner'){
      db.collection('links').onSnapshot(function(qs){
        var map = {};
        qs.docs.forEach(function(d){ map[d.id] = d.data(); });
        STATE.links = map;
        render();
      }, function(){});
    }
    db.doc('config/business').onSnapshot(function(snap){
      if(snap.exists){
        var d = snap.data();
        STATE.config = Object.assign({}, STATE.config, d);
        render();
      }
    }, function(){});
    db.collection('orders').onSnapshot(function(qs){
      var legacy = [];
      STATE.orders = qs.docs.map(function(d){
        var o = Object.assign({id:d.id}, d.data());
        if(LEGACY_STATUS[o.status]){ o.status = normStatus(o.status); legacy.push({path:'orders/'+o.id, data:{status:o.status}}); }
        return o;
      });
      STATE.orders.sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
      render();
      backfillJobNumbers();
      if(legacy.length && isOwnerRole() && !_statusBackfillDone){ _statusBackfillDone = true; updateDocs(legacy).catch(function(){ _statusBackfillDone = false; }); }
    }, function(){ toast('Could not load jobs — check your connection'); });
    startMessageFeed();
    if(isTechnician()) return; // technicians only see the job board — no customers, WhatsApp, files or downloads
    db.collection('products').onSnapshot(function(qs){
      STATE.products = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      render();
    }, function(){});
    db.collection('stocktakes').onSnapshot(function(qs){
      STATE.stocktakes = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      renderKeepCountFocus();
    }, function(){});
    db.collection('creditNotes').onSnapshot(function(qs){
      STATE.creditNotes = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      render();
    }, function(){});
    startCashupFeeds();
    db.collection('customers').orderBy('name').onSnapshot(function(qs){
      STATE.customers = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); });
      render();
    }, function(){});
    db.collection('wa_handled').onSnapshot(function(qs){
      var map = {};
      qs.docs.forEach(function(d){ map[d.id] = d.data(); });
      STATE.waHandled = map;
      render();
    }, function(){});
    STATE.assets = window.DSX.assets;
    STATE.downloads = window.DSX.downloads;
    STATE.mcp = window.DSX.mcp;
    startWaWatch();
    render();
    setTimeout(cleanupOldCloudFiles, 8000);
  }

  /* ============================ whatsapp (Bird + Cloudinary) ============================ */
  // WhatsApp runs on the Bird connector; files are hosted on Cloudinary so WhatsApp can
  // fetch them by public link. PDFs are tagged and cleaned up after 30 days.
  var WA_SERVER = 'Bird';
  var FILE_SERVER = 'Cloudinary';
  var WA_DEFAULT_FROM = '+27604934689';
  var FILE_TAG = 'dsignx-ops';
  var FILE_KEEP_DAYS = 30;
  var WINDOW_MS = 24*60*60*1000;

  function waFrom(){ return WA_DEFAULT_FROM; }
  function waTo(phone){ return '+'+waPhone(phone); }

  function waBodyOf(m){
    if(m.text && m.text.body) return m.text.body;
    if(m.document) return '📎 '+(m.document.filename||'Document')+(m.document.caption?('\n'+m.document.caption):'');
    if(m.image) return '🖼 Photo'+(m.image.caption?('\n'+m.image.caption):'');
    if(m.video) return '🎬 Video'+(m.video.caption?('\n'+m.video.caption):'');
    if(m.audio) return '🎤 Voice note';
    if(m.sticker) return 'Sticker';
    if(m.location) return '📍 Location'+(m.location.name?(': '+m.location.name):'');
    if(m.contact_cards) return '👤 Contact card';
    if(m.interactive_reply) return (m.interactive_reply.text || m.interactive_reply.title || 'Button reply');
    if(m.interactive) return m.interactive.body_text || '';
    if(m.template) return '(template message)';
    return '';
  }
  // Photo / document / video / voice note a customer sent: what we need to fetch it from Bird.
  var WA_MEDIA_KINDS = {image:'photo', document:'document', video:'video', audio:'voice note', sticker:'sticker'};
  function waMediaOf(m){
    if(!m || m.direction!=='inbound') return null;
    for(var k in WA_MEDIA_KINDS){
      var c = m[k];
      if(c && c.id) return {kind:k, id:String(c.id), mime:c.mime_type||'', filename:c.filename||'', messageId:m.id};
    }
    return null;
  }
  function waMediaButtons(media, withSave){
    if(!media) return '';
    var label = media.kind==='image' ? 'View photo' : media.kind==='document' ? ('Open '+(/pdf/i.test(media.mime) ? 'PDF' : 'document')) : ('Open '+WA_MEDIA_KINDS[media.kind]);
    var attrs = ' data-msg="'+escapeHtml(media.messageId)+'" data-media="'+escapeHtml(media.id)+'" data-kind="'+media.kind+'" data-mime="'+escapeHtml(media.mime)+'" data-name="'+escapeHtml(media.filename)+'"';
    return '<span class="wa-media-btns">' +
      '<button type="button" class="btn btn-sm" data-action="wa-media"'+attrs+'>'+label+'</button>' +
      '<button type="button" class="btn btn-ghost btn-sm" data-action="wa-media-dl"'+attrs+'>Download</button>' +
      (withSave && STATE.assets && STATE.openOrderId && (media.kind==='image' || media.kind==='document') ? '<button type="button" class="btn btn-ghost btn-sm" data-action="wa-media-save"'+attrs+'>Save to job</button>' : '') +
    '</span>';
  }
  function waMediaFilename(el, mime){
    var name = el.getAttribute('data-name');
    if(name) return name;
    var ext = (/jpe?g/.test(mime) ? 'jpg' : /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /pdf/.test(mime) ? 'pdf' : /mp4/.test(mime) ? 'mp4' : /ogg/.test(mime) ? 'ogg' : 'bin');
    return 'whatsapp-'+(el.getAttribute('data-kind')||'file')+'-'+todayIso()+'.'+ext;
  }
  function waMediaError(err){
    var msg = String((err && err.message) || '');
    if(/media_expired|410/.test(msg)) return 'This file has expired — WhatsApp only keeps customer files for 30 days. Ask the customer to send it again.';
    if(/too_large/.test(msg)) return 'The file is too big to save here (over 7 MB). Use Download instead.';
    if(/Unknown tool/.test(msg)) return 'The server needs updating before files can be opened — run the functions deploy.';
    return 'Couldn’t open the file — ' + waErrorNotice(err||{}).text;
  }
  function b64ToBlob(b64, mime){
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for(var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], {type:mime||'application/octet-stream'});
  }
  function fetchWaMedia(el, inline){
    return STATE.mcp.callTool(WA_SERVER, 'whatsapp_media', {message_id:el.getAttribute('data-msg'), media_id:el.getAttribute('data-media'), inline:!!inline})
      .then(function(r){ return (r && r.payload) || {}; });
  }
  // Opens in a new tab. The tab is opened straight away (so pop-up blockers allow it) and
  // pointed at the file once the short-lived link comes back.
  function openWaMedia(el){
    if(!STATE.mcp) return;
    var w = null;
    try { w = window.open('', '_blank'); if(w && w.document){ w.document.title = 'Opening…'; w.document.body.innerHTML = '<p style="font:15px system-ui;padding:24px;color:#555;">Opening the customer’s file…</p>'; } } catch(e){}
    toast('Opening file…');
    fetchWaMedia(el, false).then(function(d){
      var url = d.url || (d.data ? URL.createObjectURL(b64ToBlob(d.data, d.mime || el.getAttribute('data-mime'))) : '');
      if(!url) throw new Error('No file came back');
      if(w && !w.closed) w.location.href = url; else window.open(url, '_blank', 'noopener');
    }).catch(function(err){ if(w && !w.closed) w.close(); toast(waMediaError(err)); });
  }
  function downloadWaMedia(el){
    if(!STATE.mcp) return;
    toast('Downloading…');
    fetchWaMedia(el, true).then(function(d){
      if(d.url && !d.data){ window.open(d.url, '_blank', 'noopener'); return; }
      var mime = d.mime || el.getAttribute('data-mime');
      var blob = b64ToBlob(d.data, mime), name = waMediaFilename(el, mime);
      if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(e){ if(!e || e.code!=='declined') fallbackDownload(blob, name); }); }
      else fallbackDownload(blob, name);
    }).catch(function(err){ toast(waMediaError(err)); });
  }
  // Copies the customer's photo/document onto the open job as an artwork attachment.
  function saveWaMediaToJob(el){
    if(!STATE.mcp || !STATE.assets || !STATE.openOrderId) return;
    toast('Saving to the job…');
    fetchWaMedia(el, true).then(function(d){
      if(!d.data) throw new Error('too_large');
      var mime = d.mime || el.getAttribute('data-mime');
      if(mime.indexOf('image/')!==0 && mime!=='application/pdf'){ toast('Only photos and PDFs can be saved to a job — use Download for other files'); return; }
      var name = waMediaFilename(el, mime), blob = b64ToBlob(d.data, mime), file;
      try { file = new File([blob], name, {type:mime}); } catch(e){ file = blob; file.name = name; }
      handleAttach(file);
    }).catch(function(err){ toast(waMediaError(err)); });
  }

  function waContactPhone(m){
    var side = m.direction==='inbound' ? m.from : m.to;
    return side && side.phone_number ? waPhone(side.phone_number) : '';
  }

  // Inbox: one watch over recent messages; a contact is "waiting" when their latest
  // message is inbound (they wrote last).
  function handleWaEvent(ev){
    if(ev.type==='error'){
      STATE.waStatus = 'error';
      STATE.waError = ev.error;
      var retract = ['needs_reauth','server_not_connected','selection_required','not_in_manifest','blocked_by_policy','approval_required'].indexOf(ev.error.code)>=0;
      if(retract){ STATE.waConversations = []; }
      render();
      return;
    }
    var payload = (ev.result && ev.result.payload) || {};
    var msgs = (payload.data || []).filter(function(m){ return !(m.to && m.to.group_id); });
    var latest = {}, latestInbound = {};
    msgs.forEach(function(m){
      var p = waContactPhone(m);
      if(!p) return;
      if(!latest[p] || m.created_at > latest[p].created_at) latest[p] = m;
      if(m.direction==='inbound' && (!latestInbound[p] || m.created_at > latestInbound[p].created_at)) latestInbound[p] = m;
    });
    var convs = [];
    Object.keys(latest).forEach(function(p){
      var m = latest[p];
      if(m.direction!=='inbound') return;
      convs.push({phone:p, name:(m.from && m.from.display_name) || '', last_message_date:m.created_at});
      STATE.waMessages[p] = {body: waBodyOf(m) || '(open WhatsApp to view this message)', messageId: m.id, _for: m.created_at, media: waMediaOf(m)};
    });
    Object.keys(latestInbound).forEach(function(p){ STATE.waLastInbound[p] = latestInbound[p].created_at; });
    convs.sort(function(a,b){ return String(b.last_message_date).localeCompare(String(a.last_message_date)); });
    STATE.waStatus = 'ready';
    STATE.waError = null;
    STATE.waConversations = convs;
    STATE.waLastChecked = (ev.result.cache && ev.result.cache.storedAt) ? new Date(ev.result.cache.storedAt) : new Date();
    render();
  }

  function startWaWatch(){
    if(!STATE.mcp) return;
    if(STATE.waUnwatch) STATE.waUnwatch();
    STATE.waStatus = 'loading';
    STATE.waUnwatch = STATE.mcp.watchTool(WA_SERVER, 'whatsapp_list', {limit:100}, handleWaEvent, {refetchInterval:120000});
  }

  function waRefreshNow(){
    if(!STATE.mcp) return;
    STATE.waStatus = 'loading';
    render();
    STATE.mcp.invalidate(WA_SERVER,'whatsapp_list').catch(function(){ startWaWatch(); });
  }

  function markWaHandled(phone, messageId, action, orderId){
    if(!messageId) return;
    var data = {phone:phone, action:action, at:new Date().toISOString(), orderId:orderId||null};
    STATE.waHandled[messageId] = data; // optimistic, so the card disappears immediately
    if(STATE.isLive && STATE.db){
      STATE.db.collection('wa_handled').doc(messageId).set(data).catch(function(){});
    }
    if(STATE.mcp && String(messageId).indexOf('wam_')===0){
      STATE.mcp.callTool(WA_SERVER,'whatsapp_mark_read',{message_id:messageId, idempotency_key:'read-'+messageId}).catch(function(){});
    }
  }

  // Is the 24-hour reply window open for this contact? Free-form messages and files
  // only go through while it is.
  function waWindowOpen(phone){
    var t = STATE.waLastInbound[phone];
    return !!t && (Date.now() - new Date(t).getTime()) < WINDOW_MS;
  }

  /* ============================ per-job customer chat ============================ */
  function openOrderChat(phone){
    if(!phone || !STATE.mcp) return;
    var entry = STATE.chatMessages[phone] || {};
    entry.loading = true;
    STATE.chatMessages[phone] = entry;
    render();
    var to = waTo(phone);
    Promise.all([
      STATE.mcp.callTool(WA_SERVER,'whatsapp_list',{from:to, direction:'inbound', limit:30}),
      STATE.mcp.callTool(WA_SERVER,'whatsapp_list',{to:to, direction:'outbound', limit:30})
    ]).then(function(rs){
      var all = [];
      rs.forEach(function(res){ all = all.concat(((res && res.payload) || {}).data || []); });
      all.sort(function(a,b){ return String(a.created_at).localeCompare(String(b.created_at)); });
      var list = all.map(function(m){
        return {message_id:m.id, body:waBodyOf(m), from_me:m.direction==='outbound', date:m.created_at, media:waMediaOf(m),
                failed:m.status==='failed', failReason:(m.last_error && (m.last_error.description||m.last_error.code))||''};
      });
      var lastIn = all.filter(function(m){ return m.direction==='inbound'; }).pop();
      if(lastIn) STATE.waLastInbound[phone] = lastIn.created_at;
      // Merge rather than replace: an in-flight file upload for this phone stashes its
      // own fields on this entry and must survive whichever call resolves first.
      STATE.chatMessages[phone] = Object.assign({}, STATE.chatMessages[phone], {loading:false, error:null, list:list});
      render();
      if(lastIn && !lastIn.read_at){
        STATE.mcp.callTool(WA_SERVER,'whatsapp_mark_read',{message_id:lastIn.id, idempotency_key:'read-'+lastIn.id}).catch(function(){});
      }
    }).catch(function(err){
      STATE.chatMessages[phone] = Object.assign({}, STATE.chatMessages[phone], {loading:false, error:err, list:(STATE.chatMessages[phone]||{}).list||[]});
      render();
    });
  }

  function blobToDataUri(blob, mimeType){
    return new Promise(function(resolve, reject){
      var reader = new FileReader();
      reader.onload = function(){
        var r = String(reader.result || '');
        if(mimeType && r.indexOf('data:application/octet-stream')===0) r = 'data:'+mimeType+r.slice(r.indexOf(';'));
        resolve(r);
      };
      reader.onerror = function(){ reject(reader.error || new Error('Could not read file')); };
      reader.readAsDataURL(blob);
    });
  }

  function cloudSlug(filename){
    var base = String(filename||'file').toLowerCase().replace(/[^a-z0-9.\-]+/g,'-').replace(/-+/g,'-');
    var dot = base.lastIndexOf('.');
    var stem = dot>0 ? base.slice(0,dot) : base, ext = dot>0 ? base.slice(dot) : '';
    return 'dsignx-docs/'+stem.slice(0,60)+'-'+Math.random().toString(36).slice(2,10)+ext;
  }

  var MAX_UPLOAD_BYTES = 7*1024*1024;

  // Uploads a generated/fetched file to Cloudinary (public link WhatsApp can fetch) and
  // stages it as a pending send in the job's customer chat — the person still has to
  // hit Send there before anything reaches the customer.
  function attachFileToChat(phone, blob, filename, mimeType, caption){
    if(!phone || !STATE.mcp) return;
    if(blob.size > MAX_UPLOAD_BYTES){
      toast('That file is too big to send from here ('+(blob.size/1048576).toFixed(1)+' MB, limit 7 MB) — download it and send it from WhatsApp instead');
      return;
    }
    var isImage = (mimeType||blob.type||'').indexOf('image/')===0;
    var entry = Object.assign({}, STATE.chatMessages[phone]);
    entry.uploading = true;
    entry.sendError = null;
    STATE.chatMessages[phone] = entry;
    render();
    blobToDataUri(blob, mimeType).then(function(uri){
      var slug = cloudSlug(filename);
      if(isImage) slug = slug.replace(/\.[a-z0-9]+$/,''); // image public ids carry no extension
      return STATE.mcp.callTool(FILE_SERVER,'upload-asset',{
        resource_type: isImage ? 'image' : 'raw',
        upload_request: {file:uri, public_id:slug, tags:[FILE_TAG], overwrite:false}
      });
    }).then(function(res){
      var payload = (res && res.payload) || {};
      if(!payload.secure_url) throw {code:'tool_error', message:'Cloudinary did not return a link'};
      var e = Object.assign({}, STATE.chatMessages[phone]);
      e.uploading = false;
      e.pendingSend = {kind: isImage ? 'image' : 'file', url: payload.secure_url, assetId: payload.asset_id, filename: filename, caption: caption || ''};
      STATE.chatMessages[phone] = e;
      render();
    }).catch(function(err){
      var e = Object.assign({}, STATE.chatMessages[phone]);
      e.uploading = false;
      e.sendError = err;
      STATE.chatMessages[phone] = e;
      render();
      toast('Could not prepare that file for WhatsApp — ' + waErrorNotice(err).text);
    });
  }

  function waSendCall(phone, content, key){
    var input = Object.assign({from: waFrom(), to: waTo(phone), idempotency_key: key}, content);
    return STATE.mcp.callTool(WA_SERVER,'whatsapp_send',input);
  }

  // Paperclip in the job chat: pick a file on this device and stage it for sending.
  // Whatever is typed in the message box becomes the caption.
  var CLIP_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  function attachFromDevice(phone, file){
    if(!phone || !file) return;
    var type = file.type || '';
    if(type.indexOf('image/')===0 && type!=='image/jpeg' && type!=='image/png'){
      toast('WhatsApp only accepts JPG or PNG photos — save it as one of those and try again');
      return;
    }
    var caption = (STATE.chatDraft[phone]||'').trim();
    STATE.chatDraft[phone] = '';
    attachFileToChat(phone, file, file.name || 'attachment', type, caption);
  }

  function confirmChatSend(phone){
    var entry = STATE.chatMessages[phone];
    if(!entry || !entry.pendingSend || !STATE.mcp || entry.sending) return;
    var pending = entry.pendingSend;
    if(!pending.key) pending.key = 'dsx-'+uid();
    entry.sending = true;
    entry.sendError = null;
    render();

    var content;
    if(pending.kind==='image') content = {image:{url:pending.url, caption:pending.caption||null}};
    else if(pending.kind==='file') content = {document:{url:pending.url, filename:pending.filename, caption:pending.caption||null}};
    else if(pending.kind==='template') content = templateContent(pending);
    else content = {text:{body:pending.text}};

    waSendCall(phone, content, pending.key).then(function(res){
      var payload = (res && res.payload) || {};
      entry.sending = false;
      entry.pendingSend = null;
      var isText = pending.kind==='text' || !pending.kind || pending.kind==='template';
      var body = isText ? pending.text : ('📎 '+pending.filename+(pending.caption?('\n'+pending.caption):''));
      entry.list = (entry.list||[]).concat([{message_id: payload.id || ('local-'+Date.now()), body: body, from_me:true, date: new Date().toISOString()}]);
      if(isText && pending.kind!=='template'){ STATE.chatDraft[phone] = ''; }
      STATE.chatMessages[phone] = entry;
      render();
      toast(pending.kind==='template' ? 'Template sent' : (isText ? 'Message sent' : 'File sent'));
      if(payload.id) checkWaDelivery(phone, payload.id);
    }).catch(function(err){
      entry.sending = false;
      entry.sendError = err;
      STATE.chatMessages[phone] = entry;
      render();
    });
  }

  // Delivery is asynchronous: look again shortly so a refusal from WhatsApp shows up
  // in the chat instead of silently disappearing.
  function checkWaDelivery(phone, id){
    setTimeout(function(){
      if(!STATE.mcp) return;
      STATE.mcp.callTool(WA_SERVER,'whatsapp_get',{message_id:id}).then(function(res){
        var m = (res && res.payload) || {};
        if(m.status!=='failed') return;
        var entry = STATE.chatMessages[phone];
        if(!entry || !entry.list) return;
        entry.list.forEach(function(x){ if(x.message_id===id){ x.failed = true; x.failReason = (m.last_error && (m.last_error.description||m.last_error.code))||'not delivered'; } });
        render();
        toast('WhatsApp did not deliver that message — ' + waFailText(m.last_error));
      }).catch(function(){});
    }, 12000);
  }

  function waFailText(le){
    if(!le) return 'no reason given';
    var meta = String(le.meta_error_code||'');
    if(meta==='131047' || /window/i.test(le.description||'')) return 'the 24-hour reply window has closed. Ask the customer to message you first.';
    if(meta==='131031') return 'the WhatsApp business account is locked. Check WhatsApp Manager.';
    return le.description || le.code || 'no reason given';
  }

  // Remove PDFs/images this app uploaded to Cloudinary more than 30 days ago. Owner
  // only, at most once a day per device.
  function cleanupOldCloudFiles(){
    if(!STATE.mcp || !isOwnerRole()) return;
    var today = todayIso();
    try { if(localStorage.getItem('dsx-cloud-cleanup')===today) return; } catch(e){}
    var cutoff = addDays(today, -FILE_KEEP_DAYS);
    var expr = 'tags='+FILE_TAG+' AND uploaded_at<"'+cutoff+'"';
    STATE.mcp.callTool(FILE_SERVER,'search-assets',{request:{expression:expr, max_results:100, fields:'asset_id,public_id,created_at'}}).then(function(res){
      var list = (((res && res.payload) || {}).resources) || [];
      var chain = Promise.resolve();
      list.forEach(function(r){
        chain = chain.then(function(){
          return STATE.mcp.callTool(FILE_SERVER,'delete-asset',{request:{asset_id:r.asset_id, invalidate:true}}).catch(function(){});
        });
      });
      return chain.then(function(){ try { localStorage.setItem('dsx-cloud-cleanup', today); } catch(e){} });
    }).catch(function(){});
  }

  function waErrorNotice(err){
    err = err || {};
    var who = (err.server===FILE_SERVER) ? 'Cloudinary' : 'Bird (WhatsApp)';
    var msg = String(err.message||'');
    switch(err.code){
      case 'needs_reauth': return {text:'Your sign-in has expired.', action:'Sign out and sign in again.'};
      case 'server_not_connected': return {text: who+' isn’t set up on the server yet.', action:'Add its key as described in the setup guide.'};
      case 'blocked_by_policy': return {text:'Your role doesn’t allow this.', action:''};
      case 'server_unavailable': return {text:'Couldn’t reach '+who+' just now — try again in a moment.', action:''};
      case 'tool_error':
        if(/E15044|customer service window|outside.*window/i.test(msg)) return {text:'The 24-hour reply window is closed for this customer, so WhatsApp only allows approved templates.', action:'Ask them to send you a WhatsApp first, then send again.'};
        if(/131031|locked/i.test(msg)) return {text:'The WhatsApp business account is locked by Meta.', action:'Check WhatsApp Manager.'};
        return {text: who+' reported a problem: ' + (msg.length>220 ? msg.slice(0,220)+'…' : (msg||'unknown error')), action:''};
      default: return {text:'Couldn’t reach WhatsApp right now.', action:''};
    }
  }


  /* ============================ render: shell ============================ */
  function render(){
    var app = document.getElementById('app');
    var ph = STATE.auth.phase;
    if(ph!=='unlocked' && ph!=='demo'){
      app.innerHTML = renderAuthScreen();
      bindAuthEvents();
      return;
    }
    app.onsubmit = function(e){ if(e.target.getAttribute('data-auth')) e.preventDefault(); };
    if(!canAccess(STATE.tab)){ STATE.tab = firstAllowedTab(); }
    app.innerHTML =
      '<div class="shell'+(navCollapsed()?' nav-min':'')+'">' +
        renderSidebar() +
        '<div class="main">' + renderTab() + '</div>' +
      '</div>' +
      (STATE.openOrderId ? renderOrderModal() : '') +
      (STATE.newOrderOpen && !isTechnician() ? renderNewOrderModal() : '') +
      (STATE.newQuoteOpen && canAccess('quotes') ? renderNewQuoteModal() : '') +
      (STATE.newTeamOpen && isOwnerRole() ? renderNewTeamModal() : '') +
      (STATE.customerForm && canAccess('customers') ? renderCustomerForm() : '') +
      (STATE.quoteModalOrderId && canAccess('quotes') ? renderQuoteModal() : '') +
      (STATE.invoiceModalOrderId && canAccess('quotes') ? renderInvoiceModal() : '') +
      (STATE.receiptForm && !isTechnician() ? renderReceiptModal() : '') +
      (STATE.creditForm && isOwnerRole() ? renderCreditModal() : '') +
      (STATE.msgForm ? renderMsgForm() : '');
    bindEvents();
  }

  var NAV = [
    {key:'dashboard', label:'Dashboard'},
    {key:'board', label:'Job board'},
    {key:'messages', label:'Messages'},
    {key:'whatsapp', label:'WhatsApp inbox'},
    {key:'customers', label:'Customers'},
    {key:'team', label:'Team'},
    {key:'quotes', label:'Quotes & invoicing'},
    {key:'products', label:'Products'},
    {key:'cashup', label:'Cash-ups'},
    {key:'reports', label:'Reports'},
    {key:'exports', label:'Exports'},
    {key:'settings', label:'Settings'}
  ];

  function waPendingCount(){
    return STATE.waConversations.filter(function(c){
      var m = STATE.waMessages[c.phone];
      return !(m && m.messageId && STATE.waHandled[m.messageId]);
    }).length;
  }

  function navCollapsed(){
    if(STATE.navMin==null){ try { STATE.navMin = localStorage.getItem('dsx-nav-min')==='1'; } catch(e){ STATE.navMin = false; } }
    return !!STATE.navMin;
  }
  function toggleNav(){
    STATE.navMin = !navCollapsed();
    try { localStorage.setItem('dsx-nav-min', STATE.navMin ? '1' : '0'); } catch(e){}
    render();
  }
  var NAV_ICONS = {
    dashboard:'<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    board:'<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/>',
    whatsapp:'<path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.2A8.5 8.5 0 1 1 21 12z"/>',
    customers:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.6 2.5 3 5.2"/>',
    team:'<circle cx="12" cy="7.5" r="3.5"/><path d="M5 21c.9-4 3.7-6 7-6s6.1 2 7 6"/>',
    quotes:'<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    products:'<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
    cashup:'<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><circle cx="12" cy="12" r="2.5"/><path d="M6 9.5v5M18 9.5v5"/>',
    reports:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    exports:'<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
    messages:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5l8.5 6.5 8.5-6.5"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>'
  };
  function navIcon(k){ return '<svg class="nav-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(NAV_ICONS[k]||'<circle cx="12" cy="12" r="3"/>')+'</svg>'; }
  function renderSidebar(){
    var member = currentTeamMember();
    var pending = waPendingCount();
    var navList = NAV.filter(function(n){ return canAccess(n.key); });
    var items = navList.map(function(n){
      var badge = (n.key==='whatsapp' && pending) ? '<span class="badge">'+pending+'</span>' : '';
      if(n.key==='messages'){ var mc = msgAttnCount(); if(mc) badge = '<span class="badge">'+mc+'</span>'; }
      return '<li><button data-action="tab" data-tab="'+n.key+'" class="'+(STATE.tab===n.key?'active':'')+'" title="'+n.label+'">'+navIcon(n.key)+'<span class="nav-label">'+n.label+'</span>'+badge+'</button></li>';
    }).join('');
    var viewerPill = STATE.auth.phase==='demo' ? '<div class="who-box"><div><strong>Demo mode</strong><span style="font-size:11px;">Sample data only. Changes are not saved and nothing is sent. '+escapeHtml(STATE.demoReason||'')+'</span></div></div>' : (
      '<div class="who-box"><div><span style="font-size:11px;">Signed in</span><strong>'+(member?escapeHtml(member.name):'Owner')+'</strong>' +
        '<span style="font-size:11px;">'+(isOwnerRole()?'':roleLabel(currentRole())+' &middot; ')+'<a href="#" data-action="change-password">Change password</a></span></div>' +
        '<button type="button" class="btn btn-sm" data-action="lock-app" title="Lock DsignX Ops">'+LOCK_ICON+' Lock</button></div>'
    );
    return (
      '<div class="sidebar">' +
        '<button type="button" class="nav-toggle" data-action="toggle-nav" title="'+(navCollapsed()?'Show the menu':'Hide the menu')+'" aria-label="'+(navCollapsed()?'Show the menu':'Hide the menu')+'">'+(navCollapsed()?'&raquo;':'&laquo;')+'</button>' +
        '<div class="brand"><div class="brand-mark"><img src="'+LOGO_MARK_DATA_URL+'" alt="DsignX"></div><div class="brand-text"><div class="name">DsignX</div><div class="tag">Ops</div></div></div>' +
        '<ul class="navlist">' + items + '</ul>' +
        viewerPill +
        '<div class="sidebar-foot">Signage &middot; printing &middot; sublimation<br>Kroonstad, South Africa<br><span style="opacity:.6;">Version 2026-10-23.26</span></div>' +
      '</div>'
    );
  }

  function renderTab(){
    switch(STATE.tab){
      case 'board': return renderBoardTab();
      case 'messages': return renderMessagesTab();
      case 'whatsapp': return renderWhatsAppTab();
      case 'customers': return renderCustomersTab();
      case 'team': return renderTeamTab();
      case 'quotes': return renderQuotesTab();
      case 'products': return renderProductsTab();
      case 'cashup': return renderCashupTab();
      case 'settings': return renderSettingsTab();
      case 'reports': return renderReportsTab();
      case 'exports': return renderExportsTab();
      default: return renderDashboardTab();
    }
  }

  function exampleBadge(){
    if(STATE.isLive) return '';
    return '<span class="example-badge" title="This view is showing sample jobs so you can see how the board works. Sign in to see your real jobs.">Example data</span>';
  }

  /* ============================ dashboard ============================ */
  function renderDashboardTab(){
    var member = currentTeamMember();
    var open = ordersActive();
    if(member){ open = open.filter(function(o){ return onJob(o, member.id); }); }
    var dueSoon = open.filter(function(o){ return o.dueDate; }).sort(function(a,b){ return a.dueDate.localeCompare(b.dueDate); }).slice(0,6);
    var quotedValue = STATE.orders.filter(function(o){ return o.quoteAmount && !o.invoiced; }).reduce(function(s,o){ return s+Number(o.quoteAmount); },0);
    var thisWeek = open.filter(function(o){ var d=daysUntil(o.dueDate); return d!==null && d<=7 && d>=0; }).length;
    var overdue = open.filter(function(o){ var d=daysUntil(o.dueDate); return d!==null && d<0; }).length;

    var tiles = member ?
      (tile('Your open jobs', open.length, 'Assigned to you') +
       tile('Due this week', thisWeek, overdue ? (overdue+' overdue') : 'On schedule')) :
      (tile('Open jobs', open.length, 'Not yet collected') +
       tile('Due this week', thisWeek, overdue ? (overdue+' overdue') : 'On schedule') +
       tile('Awaiting invoice', money(quotedValue), 'Quoted, not yet invoiced') +
       tile('Customers', STATE.customers.length, 'In your books'));

    var dueRows = dueSoon.length ? dueSoon.map(function(o){
      var d = daysUntil(o.dueDate);
      var cls = d<0 ? 'overdue' : (d<=2 ? 'soon' : '');
      var label = d<0 ? (Math.abs(d)+'d overdue') : (d===0 ? 'Due today' : (d+'d left'));
      return '<div class="due-row">' +
        '<div><div class="who">'+escapeHtml(o.customerName)+'</div><div class="what">'+escapeHtml(o.title)+'</div></div>' +
        '<span class="status-chip status-'+o.status+'">'+statusMeta(o.status).label+'</span>' +
        '<div class="due-date '+cls+'">'+label+' &middot; '+shortDate(o.dueDate)+'</div>' +
      '</div>';
    }).join('') : '<div class="empty-note">'+(member ? 'Nothing due — nothing with a date is assigned to you right now.' : 'Nothing with a due date yet — add one from the job board.')+'</div>';

    var msgN = msgAttnCount();
    var msgBanner = msgN ? ('<div class="wa-banner">'+msgN+' message'+(msgN===1?'':'s')+' (enquiries or tasks) need your attention<button class="btn btn-sm" data-action="tab" data-tab="messages">Open messages</button></div>') : '';
    var waPending = (STATE.mcp && !member) ? waPendingCount() : 0;
    var waBanner = waPending ? ('<div class="wa-banner">'+waPending+' new WhatsApp message'+(waPending===1?'':'s')+' waiting to be logged<button class="btn btn-sm" data-action="tab" data-tab="whatsapp">Review inbox</button></div>') : '';

    var subLine = escapeHtml(STATE.config.businessName||'DsignX')+' &middot; '+fullDate(todayIso())+(member ? ' &middot; showing jobs assigned to '+escapeHtml(member.name) : '');

    return (
      '<div class="topline"><div><h1>Dashboard</h1><div class="sub">'+subLine+'</div></div>' + exampleBadge() +
        '<button class="btn btn-primary" data-action="open-new-order">+ New order</button>' +
      '</div>' +
      msgBanner + waBanner +
      '<div class="tiles">'+tiles+'</div>' +
      '<div class="panel"><div class="panel-head"><h2>Coming up</h2></div>' + dueRows + '</div>'
    );
  }
  function tile(label, value, note){
    return '<div class="tile"><div class="label">'+label+'</div><div class="value">'+value+'</div><div class="note">'+note+'</div></div>';
  }

  /* ============================ board ============================ */
  function renderBoardTab(){
    var q = STATE.boardQuery.trim().toLowerCase();
    var af = STATE.boardAssigneeFilter;
    var cols = STATUSES.map(function(s){
      var items = STATE.orders.filter(function(o){ return o.status===s.key; });
      var hiddenOld = 0;
      if(s.key==='collected' && !STATE.showAllCollected && !q){
        var cutoff = addDays(todayIso(), -COLLECTED_SHOW_DAYS);
        var recent = items.filter(function(o){ return String(o.collectedAt || o.updatedAt || o.createdAt || '').slice(0,10) >= cutoff; });
        hiddenOld = items.length - recent.length; items = recent;
      }
      if(q){ items = items.filter(function(o){ return (o.title+' '+o.customerName+' '+(o.designerName||'')+' '+techNames(o)+' '+(o.jobNumber||'')+' '+(o.poNumber||'')).toLowerCase().indexOf(q)>=0; }); }
      if(af==='unassigned'){ items = items.filter(isUnassigned); }
      else if(af && af!=='all'){ items = items.filter(function(o){ return onJob(o, af); }); }
      var cards = items.map(cardHtml).join('');
      return (
        '<div class="col" data-status="'+s.key+'">' +
          '<div class="col-head"><span class="t">'+s.label+'</span><span class="n">'+items.length+'</span></div>' +
          '<div class="col-cards">'+cards+'</div>' +
          (s.key==='collected' && (hiddenOld || STATE.showAllCollected) ? '<button type="button" class="btn btn-ghost btn-sm col-more" data-action="toggle-collected">'+(STATE.showAllCollected ? 'Show the last '+COLLECTED_SHOW_DAYS+' days only' : '+ '+hiddenOld+' collected earlier')+'</button>' : '') +
        '</div>'
      );
    }).join('');

    var assigneeOpts = '<option value="all" '+(af==='all'?'selected':'')+'>Everyone</option><option value="unassigned" '+(af==='unassigned'?'selected':'')+'>Unassigned</option>' +
      TEAM_ROLES.map(function(r){
        var members = STATE.team.filter(function(m){ return m.role===r.key; });
        if(!members.length) return '';
        return '<optgroup label="'+r.plural+'">' + members.map(function(m){ return '<option value="'+m.id+'" '+(af===m.id?'selected':'')+'>'+escapeHtml(m.name)+'</option>'; }).join('') + '</optgroup>';
      }).join('');

    return (
      '<div class="topline"><div><h1>Job board</h1><div class="sub">Drag a card to move it, or click to open</div></div>' + exampleBadge() +
        (isTechnician() ? '' : '<button class="btn btn-primary" data-action="open-new-order">+ New order</button>') +
      '</div>' +
      '<div class="filterbar" style="margin-bottom:14px;">' +
        '<div class="search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input type="text" placeholder="Search jobs or customers" id="boardSearch" value="'+escapeHtml(STATE.boardQuery)+'"></div>' +
        '<select class="select-inline" id="boardAssignee">'+assigneeOpts+'</select>' +
      '</div>' +
      '<div class="board-scroll"><div class="board">'+cols+'</div></div>'
    );
  }
  function cardHtml(o){
    var d = daysUntil(o.dueDate);
    var overdue = d!==null && d<0 && DONE_STATUSES.indexOf(o.status)<0;
    var avatars = '';
    if(o.designerName) avatars += '<div class="avatar designer" title="Designer: '+escapeHtml(o.designerName)+'">'+initials(o.designerName)+'</div>';
    if(o.technicianName) avatars += '<div class="avatar technician" title="Technician: '+escapeHtml(o.technicianName)+'">'+initials(o.technicianName)+'</div>';
    if(o.technician2Name) avatars += '<div class="avatar technician" title="Technician: '+escapeHtml(o.technician2Name)+'">'+initials(o.technician2Name)+'</div>';
    return (
      '<div class="card" draggable="true" data-id="'+o.id+'" data-action="open-order">' +
        '<div class="jobno">'+jobNo(o.id)+(orderDateOf(o)?'<span class="ordered" title="Order date">Ordered '+shortDate(orderDateOf(o))+'</span>':'')+'</div>' +
        '<h4>'+escapeHtml(o.title)+'</h4>' +
        '<div class="who">'+escapeHtml(o.customerName)+(o.poNumber ? ' <span class="po-tag">PO '+escapeHtml(o.poNumber)+'</span>' : '')+'</div>' +
        '<span class="cat"><span class="dot" style="background:'+catMeta(o.category).dot+'"></span>'+catMeta(o.category).label+'</span>' +
        (avatars ? '<div class="assignee-row">'+avatars+'</div>' : '') +
        '<div class="meta">' +
          '<span class="due'+(overdue?' overdue':'')+'">'+(o.dueDate?shortDate(o.dueDate):'No date')+'</span>' +
          (isTechnician() ? '' : '<span class="amt">'+(o.quoteAmount?money(o.quoteAmount):'—')+'</span>') +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ whatsapp inbox tab ============================ */
  function renderWhatsAppTab(){
    var head = '<div class="topline"><div><h1>WhatsApp inbox</h1><div class="sub">Customers who messaged last and are waiting for a reply · via Bird</div></div></div>';

    if(!STATE.mcp){
      return head + '<div class="panel"><p style="margin:0 0 10px;">This app isn\'t connected to a WhatsApp tool yet, so orders won\'t appear here automatically.</p><p class="hint" style="margin:0;">WhatsApp needs the Bird and Cloudinary keys set up on the server (see the setup guide), then reload this page. Until then, share your order link from the Settings tab and log messages here manually with <strong>+ New order</strong>.</p></div>';
    }

    var statusRow = '';
    if(STATE.waStatus==='error' && STATE.waError){
      var notice = waErrorNotice(STATE.waError);
      statusRow = '<div class="wa-status error">'+escapeHtml(notice.text)+(notice.action?(' '+escapeHtml(notice.action)):'')+'</div>';
    } else {
      var checked = STATE.waLastChecked ? ('Checked '+relTime(STATE.waLastChecked)) : (STATE.waStatus==='loading' ? 'Checking WhatsApp…' : 'Not checked yet');
      statusRow = '<div class="wa-status">'+checked+'<button class="btn btn-sm refresh" data-action="wa-refresh">Check now</button></div>';
    }

    var visible = STATE.waConversations.filter(function(c){
      var m = STATE.waMessages[c.phone];
      if(m && m.messageId && STATE.waHandled[m.messageId]) return false;
      return true;
    });
    // keep the conversation you're replying to on screen, even once it's no longer "waiting"
    var ir = STATE.inboxReply;
    if(ir && !visible.some(function(c){ return c.phone===ir.phone; })){
      visible.unshift({phone:ir.phone, name:ir.name, last_message_date:ir.date, replied:true});
    }

    var cards = visible.length ? visible.map(function(c){
      var m = STATE.waMessages[c.phone];
      var bodyHtml = !m ? (c.replied ? 'Replied — see the chat below.' : 'Loading message…') : (m.error ? '(couldn\'t load this message — open WhatsApp to view it)' : escapeHtml(m.body));
      var replying = !!(STATE.inboxReply && STATE.inboxReply.phone===c.phone);
      var msgId = (m && m.messageId) ? m.messageId : '';
      return (
        '<div class="wa-card">' +
          '<div class="wa-card-head"><span class="nm">'+escapeHtml(c.name||c.phone)+'</span><span class="ph">+'+escapeHtml(c.phone)+'</span><span class="when">'+relTime(c.last_message_date)+'</span></div>' +
          '<div class="wa-body">'+bodyHtml+(m && m.media && !m.error ? '<div style="margin-top:8px;">'+waMediaButtons(m.media, false)+'</div>' : '')+'</div>' +
          '<div class="wa-actions">' +
            '<button class="btn btn-primary btn-sm" data-action="log-wa-order" data-phone="'+escapeHtml(c.phone)+'" data-name="'+escapeHtml(c.name||'')+'" data-msgid="'+escapeHtml(msgId)+'" '+(m?'':'disabled')+'>Log as order</button>' +
            '<button class="btn btn-sm" data-action="inbox-reply" data-phone="'+escapeHtml(c.phone)+'" data-name="'+escapeHtml(c.name||'')+'" data-date="'+escapeHtml(c.last_message_date||'')+'">'+(replying ? 'Close reply' : 'Reply')+'</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="dismiss-wa-order" data-phone="'+escapeHtml(c.phone)+'" data-msgid="'+escapeHtml(msgId)+'" '+((msgId||replying)?'':'disabled')+'>'+(replying ? 'Done — not an order' : 'Not an order')+'</button>' +
          '</div>' +
          (replying ? '<div class="wa-reply">'+renderChatSection(inboxContact(c.phone, c.name))+'</div>' : '') +
        '</div>'
      );
    }).join('') : '<div class="panel"><div class="empty-note">Nothing waiting — new WhatsApp messages will show up here within a couple of minutes.</div></div>';

    return head + statusRow + '<div class="wa-list">'+cards+'</div>';
  }

  function relTime(dateLike){
    var d = (dateLike instanceof Date) ? dateLike : new Date(String(dateLike).replace(' ','T'));
    if(isNaN(d)) return '';
    var diffMs = Date.now() - d.getTime();
    var mins = Math.round(diffMs/60000);
    if(mins < 1) return 'just now';
    if(mins < 60) return mins+'m ago';
    var hrs = Math.round(mins/60);
    if(hrs < 24) return hrs+'h ago';
    return Math.round(hrs/24)+'d ago';
  }

  /* ============================ reports: commission ============================ */
  // Sliding scale on total sales excl. VAT for the month. The bracket the month's total falls in sets
  // the rate, and that rate applies to the whole total.
  var COMMISSION_TIERS = [
    {from:0,      to:49999,  rate:1.125},
    {from:50000,  to:64999,  rate:2.25},
    {from:65000,  to:79999,  rate:3.38},
    {from:80000,  to:99999,  rate:4.50},
    {from:100000, to:149999, rate:5.63},
    {from:150000, to:null,   rate:6.75}
  ];
  function tierIndexFor(total){
    for(var i=COMMISSION_TIERS.length-1;i>=0;i--){ if(total >= COMMISSION_TIERS[i].from) return i; }
    return 0;
  }
  function round2(n){ return Math.round((Number(n)||0)*100)/100; }
  function commissionFor(total){
    var i = tierIndexFor(total), t = COMMISSION_TIERS[i];
    return {tier:i, rate:t.rate, amount:round2(total * t.rate / 100), next:COMMISSION_TIERS[i+1]||null};
  }
  function fmtRate(r){ var s = String(r); return (s.indexOf('.')<0 ? s+'.00' : (s.split('.')[1].length<2 ? s+'0' : s)) + '%'; }
  function tierLabel(t){ return t.to===null ? (money(t.from)+' and more') : (money(t.from)+' – '+money(t.to)); }

  function isSale(o){ return !!(o.invoiced || o.status==='invoiced'); }
  function saleDate(o){ return o.invoiceGeneratedAt || o.invoicedAt || o.updatedAt || o.createdAt || ''; }
  function saleExVat(o){
    if(o.invoiceLineItems && o.invoiceLineItems.length){
      return round2(o.invoiceLineItems.reduce(function(s,li){ return s + lineNet(li); }, 0) - orderCreditedExVat(o.id));
    }
    return round2(Number(o.quoteAmount)||0); // quote amounts are stored excl. VAT
  }
  function salesInRange(from, to){
    return STATE.orders.filter(function(o){
      if(!isSale(o)) return false;
      var d = String(saleDate(o)).slice(0,10);
      return (!from || d >= from) && (!to || d <= to);
    });
  }
  function monthBounds(d){ return {from:localIso(new Date(d.getFullYear(), d.getMonth(), 1)), to:localIso(new Date(d.getFullYear(), d.getMonth()+1, 0))}; }
  function reportRange(){
    if(!STATE.reportFrom && !STATE.reportTo){ var b = monthBounds(new Date()); STATE.reportFrom = b.from; STATE.reportTo = b.to; }
    var f = STATE.reportFrom, t = STATE.reportTo;
    if(f && t && f > t){ var x = f; f = t; t = x; }
    return {from:f, to:t};
  }
  // A range that is exactly one calendar month, or null
  function rangeIsMonth(r){
    if(!r.from || !r.to) return null;
    var b = monthBounds(new Date(r.from+'T00:00:00'));
    return (b.from===r.from && b.to===r.to) ? r.from.slice(0,7) : null;
  }
  function rangeLabel(r){
    var m = rangeIsMonth(r);
    if(m) return monthLabel(m);
    return (r.from ? fullDate(r.from) : 'Start') + ' – ' + (r.to ? fullDate(r.to) : 'today');
  }
  function reportPresets(){
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    var q0 = Math.floor(m/3)*3;
    var taxStart = new Date(m>=2 ? y : y-1, 2, 1);
    var tm = monthBounds(now), lm = monthBounds(new Date(y, m-1, 1));
    return [
      {label:'This month', from:tm.from, to:tm.to},
      {label:'Last month', from:lm.from, to:lm.to},
      {label:'This quarter', from:localIso(new Date(y, q0, 1)), to:localIso(new Date(y, q0+3, 0))},
      {label:'Tax year to date', from:localIso(taxStart), to:todayIso()}
    ];
  }
  function monthLabel(ym){
    var d = new Date(ym+'-01T00:00:00');
    return isNaN(d) ? ym : d.toLocaleDateString('en-ZA',{month:'long', year:'numeric'});
  }
  function shiftMonth(ym, by){
    var p = ym.split('-'), d = new Date(Number(p[0]), Number(p[1])-1+by, 1);
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
  }

  // The designer earns on the full value of a job. Technicians do too, unless two technicians
  // share the job: then each is credited half (50/50).
  function creditShare(o, id){
    if(o.designerId===id) return 1;
    if(o.technicianId && o.technician2Id && o.technicianId!==o.technician2Id && isTechOn(o, id)) return 0.5;
    return isTechOn(o, id) ? 1 : 0;
  }
  function commissionRows(r){
    var sales = salesInRange(r.from, r.to);
    var rows = STATE.team.map(function(m){
      var jobs = sales.filter(function(o){ return onJob(o, m.id); });
      var total = round2(jobs.reduce(function(s,o){ return s + saleExVat(o) * creditShare(o, m.id); }, 0));
      var c = commissionFor(total);
      return {member:m, jobs:jobs, total:total, rate:c.rate, tier:c.tier, commission:c.amount, next:c.next};
    });
    var unassigned = sales.filter(isUnassigned);
    return {
      rows: rows,
      salesTotal: round2(sales.reduce(function(s,o){ return s + saleExVat(o); }, 0)),
      salesCount: sales.length,
      unassignedTotal: round2(unassigned.reduce(function(s,o){ return s + saleExVat(o); }, 0)),
      unassignedCount: unassigned.length
    };
  }

  function renderReportsTab(){
    var range = reportRange();
    if(STATE.reportView==='cashup' && canCashup()) return renderCashupReport(range);
    if(STATE.reportView==='age' && canSeeSalesReports()) return renderAgeReport();
    if(STATE.reportView==='quotes' && canSeeSalesReports()) return renderQuoteStats(range);
    var data = commissionRows(range);
    var isMonth = rangeIsMonth(range);
    var periodWord = isMonth ? 'month' : 'period';
    var me = currentTeamMember();
    var ownerView = isOwnerRole();
    var rows = ownerView ? data.rows : data.rows.filter(function(r){ return me && r.member.id===me.id; });
    rows = rows.slice().sort(function(a,b){ return b.total - a.total || String(a.member.name).localeCompare(b.member.name); });
    var commissionTotal = round2(rows.reduce(function(s,r){ return s + r.commission; }, 0));

    var tableRows = rows.map(function(r){
      var pct = 100, nextNote = '<div class="next-note">Top bracket reached</div>';
      if(r.next){
        var cur = COMMISSION_TIERS[r.tier];
        pct = Math.max(2, Math.min(100, (r.total - cur.from) / (r.next.from - cur.from) * 100));
        nextNote = '<div class="next-note">'+money(round2(r.next.from - r.total))+' more for '+fmtRate(r.next.rate)+'</div>';
      }
      var open = STATE.reportOpenMember===r.member.id;
      var main = '<tr class="row-btn" data-action="report-toggle" data-id="'+r.member.id+'">' +
        '<td><strong>'+escapeHtml(r.member.name)+'</strong><div style="font-size:11.5px; color:var(--ink-faint);">'+roleLabel(r.member.role)+'</div></td>' +
        '<td class="num">'+r.jobs.length+'</td>' +
        '<td class="num">'+money(r.total)+'<div class="progress" title="Progress to the next bracket"><i style="width:'+pct.toFixed(1)+'%"></i></div>'+nextNote+'</td>' +
        '<td class="num"><span class="rate-chip">'+fmtRate(r.rate)+'</span></td>' +
        '<td class="num"><strong>'+money(r.commission)+'</strong></td>' +
      '</tr>';
      var detail = '';
      if(open){
        var jr = r.jobs.length ? r.jobs.slice().sort(function(a,b){ return String(saleDate(a)).localeCompare(String(saleDate(b))); }).map(function(o){
          var asRole = (o.designerId===r.member.id && isTechOn(o, r.member.id)) ? 'Designer & technician' : (o.designerId===r.member.id ? 'Designer' : 'Technician'+(creditShare(o, r.member.id)===0.5 ? ' (shared 50/50 with '+escapeHtml(firstName(o.technicianId===r.member.id ? o.technician2Name : o.technicianName))+')' : ''));
          var credit = creditShare(o, r.member.id);
          return '<tr><td>'+shortDate(String(saleDate(o)).slice(0,10))+'</td><td>'+escapeHtml(o.invoiceNumber||jobNo(o.id))+'</td><td>'+escapeHtml(o.title)+'<div style="font-size:11px; color:var(--ink-faint);">'+escapeHtml(o.customerName||'')+' &middot; '+asRole+'</div></td><td class="num">'+money(round2(saleExVat(o)*credit))+(credit<1 ? '<div style="font-size:11px; color:var(--ink-faint);">of '+money(saleExVat(o))+'</div>' : '')+'</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty-note">No invoiced jobs in this '+periodWord+'.</td></tr>';
        detail = '<tr><td colspan="5" style="padding:0 0 4px;"><div class="breakdown"><table><thead><tr><th>Date</th><th>Invoice</th><th>Job</th><th style="text-align:right;">Credited (excl. VAT)</th></tr></thead><tbody>'+jr+'</tbody></table></div></td></tr>';
      }
      return main + detail;
    }).join('');
    if(!rows.length){
      tableRows = '<tr><td colspan="5" class="empty-note">'+(ownerView ? 'Add designers and technicians on the Team tab to see their commission.' : 'You’re not set up as a team member yet.')+'</td></tr>';
    } else if(ownerView){
      tableRows += '<tr class="total-row"><td>Total commission</td><td></td><td></td><td></td><td class="num">'+money(commissionTotal)+'</td></tr>';
    }

    var tiers = COMMISSION_TIERS.map(function(t, i){
      var hit = !ownerView && rows[0] && rows[0].tier===i;
      return '<div class="tier-row'+(hit?' hit':'')+'"><span>'+tierLabel(t)+'</span><span class="r">'+fmtRate(t.rate)+'</span></div>';
    }).join('');

    var note = (ownerView && data.unassignedCount) ? '<div class="rep-note">'+data.unassignedCount+' invoiced job'+(data.unassignedCount===1?'':'s')+' ('+money(data.unassignedTotal)+') this '+periodWord+' '+(data.unassignedCount===1?'has':'have')+' no designer or technician assigned, so '+(data.unassignedCount===1?'it doesn’t':'they don’t')+' count towards anyone’s commission.</div>' : '';

    var tilesHtml = ownerView ?
      (tile('Sales excl. VAT', money(data.salesTotal), data.salesCount+' invoiced job'+(data.salesCount===1?'':'s')) +
       tile('Commission payable', money(commissionTotal), rows.filter(function(r){ return r.commission>0; }).length+' team member'+(rows.filter(function(r){ return r.commission>0; }).length===1?'':'s')) +
       tile('Unassigned sales', money(data.unassignedTotal), 'Not counted for commission') +
       tile('Commission vs sales', data.salesTotal ? ((commissionTotal/data.salesTotal*100).toFixed(2)+'%') : '—', 'Of this '+periodWord+'’s sales'))
      : (rows[0] ? (tile('Your sales excl. VAT', money(rows[0].total), rows[0].jobs.length+' invoiced job'+(rows[0].jobs.length===1?'':'s')) + tile('Your rate', fmtRate(rows[0].rate), rows[0].next ? (money(round2(rows[0].next.from-rows[0].total))+' to '+fmtRate(rows[0].next.rate)) : 'Top bracket') + tile('Your commission', money(rows[0].commission), rangeLabel(range))) : '');

    return (
      '<div class="topline"><div><h1>Reports</h1><div class="sub">Commission report &middot; '+rangeLabel(range)+(ownerView?'':' &middot; your figures only')+'</div></div>' + exampleBadge() +
        '<div style="display:flex; gap:8px;">' + (ownerView ? '<button class="btn btn-sm" data-action="report-export">Download CSV</button>' : '') + '<button class="btn btn-primary btn-sm" data-action="report-pdf">Download PDF</button></div>' +
      '</div>' +
      reportSwitcher() +
      '<div class="panel" style="padding:12px 14px; margin-bottom:16px;">' +
        '<div class="period-bar">' +
          reportPresets().map(function(p){
            var on = range.from===p.from && range.to===p.to;
            return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="report-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>';
          }).join('') +
          '<span style="flex:1"></span>' +
          (isMonth ? '<button class="btn btn-sm" data-action="report-month" data-by="-1" aria-label="Previous month">&larr;</button>' : '') +
          '<label for="reportFrom" style="margin:0;">From</label><input type="date" id="reportFrom" value="'+escapeHtml(range.from||'')+'" style="width:auto;">' +
          '<label for="reportTo" style="margin:0;">To</label><input type="date" id="reportTo" value="'+escapeHtml(range.to||'')+'" style="width:auto;">' +
          (isMonth ? '<button class="btn btn-sm" data-action="report-month" data-by="1" aria-label="Next month">&rarr;</button>' : '') +
        '</div>' +
        (isMonth ? '' : '<div class="hint" style="margin-top:8px;">Custom period: the sliding scale is applied to each person’s total sales for the whole period you’ve picked. Commission is normally worked out per calendar month.</div>') +
      '</div>' +
      '<div class="tiles"'+(ownerView?'':' style="grid-template-columns:repeat(3,1fr);"')+'>'+tilesHtml+'</div>' +
      note +
      '<div class="two-col">' +
        '<div class="panel"><div class="panel-head"><h2>Commission by team member</h2><span class="hint" style="margin:0;">Tap a row for the jobs behind it</span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>Team member</th><th style="text-align:right;">Jobs</th><th style="text-align:right;">Sales excl. VAT</th><th style="text-align:right;">Rate</th><th style="text-align:right;">Commission</th></tr></thead><tbody>'+tableRows+'</tbody></table></div>' +
        '</div>' +
        '<div class="panel"><div class="panel-head"><h2>Sliding scale</h2></div>' +
          '<div class="tier-list">'+tiers+'</div>' +
          '<div class="hint" style="margin-top:10px;">Each person’s total invoiced sales excl. VAT for the period sets their bracket, and that rate is paid on the whole total. Designers and technicians earn on the full value of jobs they’re assigned to; when two technicians share a job, each is credited half. A job counts on the date it was invoiced.</div>' +
        '</div>' +
      '</div>'
    );
  }

  function exportCommissionCsv(){
    var range = reportRange(), data = commissionRows(range);
    var ym = (range.from||'start')+' to '+(range.to||todayIso());
    function q(v){ v = String(v==null?'':v); return /[",\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
    var lines = [['Period','Team member','Role','Invoiced jobs','Sales excl VAT','Commission rate','Commission'].join(',')];
    data.rows.forEach(function(r){
      lines.push([ym, r.member.name, roleLabel(r.member.role), r.jobs.length, r.total.toFixed(2), r.rate, r.commission.toFixed(2)].map(q).join(','));
    });
    lines.push('');
    lines.push(['Period','Team member','Invoice','Job','Customer','Date','Sales excl VAT'].join(','));
    data.rows.forEach(function(r){
      r.jobs.forEach(function(o){ lines.push([ym, r.member.name, o.invoiceNumber||jobNo(o.id), o.title, o.customerName, String(saleDate(o)).slice(0,10), saleExVat(o).toFixed(2)].map(q).join(',')); });
    });
    var csv = lines.join('\r\n'), filename = 'dsignx-commission-'+(rangeIsMonth(range)||((range.from||'start')+'_to_'+(range.to||todayIso())))+'.csv';
    if(STATE.downloads){
      STATE.downloads.save({filename:filename, data:csv}).then(function(){ toast('Commission report downloaded'); }).catch(function(e){
        if(e && e.code==='declined'){ toast('Download cancelled'); } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); }
      });
    } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); }
  }

  /* ============================ invoice export (Xero "Sales invoices" template) ============================ */
  var XERO_INVOICE_COLUMNS = ['ContactName','EmailAddress','POAddressLine1','POAddressLine2','POAddressLine3','POAddressLine4','POCity','PORegion','POPostalCode','POCountry','SAAddressLine1','SAAddressLine2','SAAddressLine3','SAAddressLine4','SACity','SARegion','SAPostalCode','SACountry','InvoiceNumber','Reference','InvoiceDate','DueDate','PlannedDate','Total','TaxTotal','InvoiceAmountPaid','InvoiceAmountDue','InventoryItemCode','Description','Quantity','UnitAmount','Discount','LineAmount','AccountCode','TaxType','TaxAmount','TrackingName1','TrackingOption1','TrackingName2','TrackingOption2','Currency','Type','Sent','Status'];

  function issuedInvoices(){
    return STATE.orders.filter(function(o){ return isSale(o) || (o.invoiceNumber && o.invoiceGeneratedAt); });
  }
  function invoiceDateOf(o){ return String(o.invoiceGeneratedAt || o.invoicedAt || o.updatedAt || o.createdAt || todayIso()).slice(0,10); }
  function invoicesInRange(){
    var from = STATE.invExportFrom, to = STATE.invExportTo;
    if(from && to && from > to){ var t = from; from = to; to = t; }
    return issuedInvoices().filter(function(o){
      var d = invoiceDateOf(o);
      return (!from || d >= from) && (!to || d <= to);
    }).sort(function(a,b){ return invoiceDateOf(a).localeCompare(invoiceDateOf(b)) || String(a.invoiceNumber||'').localeCompare(String(b.invoiceNumber||'')); });
  }
  function dmy(iso){ var p = String(iso||'').slice(0,10).split('-'); return p.length===3 ? (p[2]+'/'+p[1]+'/'+p[0]) : ''; }
  function f4(n){ return (Math.round((Number(n)||0)*10000)/10000).toFixed(4); }
  function firstName(n){ return String(n||'').trim().split(/\s+/)[0] || ''; }

  // Builds the line rows for one invoice. Unit prices in the app are excl. VAT, as in the template.
  function xeroRowsFor(o){
    var items = (o.invoiceLineItems && o.invoiceLineItems.length) ? o.invoiceLineItems
      : (o.lineItems && o.lineItems.length) ? o.lineItems
      : [{description:o.title||'Job', qty:o.qty||1, unitPrice:(Number(o.quoteAmount)||0)/(Number(o.qty)||1)}];
    var vatOn = isVatVendor() && (o.invoiceVatEnabled!=null ? !!o.invoiceVatEnabled : (o.quoteVatEnabled!=null ? !!o.quoteVatEnabled : true));
    var rate = vatOn ? (Number(STATE.config.vatRate)||0)/100 : 0;
    var lines = items.map(function(li){
      var qty = Number(li.qty)||0, unit = Number(li.unitPrice)||0;
      var amount = round2(lineNet(li));
      return {desc:li.description||o.title||'', qty:qty, unit:unit, disc:lineDiscPct(li), amount:amount, tax:round2(amount*rate)};
    });
    var taxTotal = round2(lines.reduce(function(s,l){ return s+l.tax; },0));
    var total = round2(lines.reduce(function(s,l){ return s+l.amount; },0) + taxTotal);
    var cust = STATE.customers.find(function(c){ return c.id===o.customerId; }) || {};
    var date = invoiceDateOf(o);
    var due = addDays(date, o.invoiceDueDays!=null ? o.invoiceDueDays : (STATE.config.invoiceDueDays||7));
    var reps = [o.designerName, o.technicianName, o.technician2Name].filter(Boolean).map(firstName).filter(function(n,i,a){ return a.indexOf(n)===i; }).join(' & ');
    var paid = 0;
    return lines.map(function(l){
      var r = {};
      XERO_INVOICE_COLUMNS.forEach(function(c){ r[c] = ''; });
      r.ContactName = o.customerName || cust.name || '';
      r.EmailAddress = cust.email || '';
      var ipa = cust.postalAddress || {}, ida = cust.postalAddress ? customerDeliveryAddress(cust) : {};
      r.POAddressLine1 = ipa.line1||''; r.POAddressLine2 = ipa.line2||''; r.POCity = ipa.city||''; r.PORegion = ipa.region||''; r.POPostalCode = ipa.postalCode||''; r.POCountry = addrHasData(ipa) ? (ipa.country||'') : '';
      r.SAAddressLine1 = ida.line1||''; r.SAAddressLine2 = ida.line2||''; r.SACity = ida.city||''; r.SARegion = ida.region||''; r.SAPostalCode = ida.postalCode||''; r.SACountry = addrHasData(ida) ? (ida.country||'') : '';
      r.InvoiceNumber = o.invoiceNumber || jobNo(o.id);
      r.Reference = (o.poNumber ? 'PO '+o.poNumber : '') || o.title || '';
      r.InvoiceDate = dmy(date);
      r.DueDate = dmy(due);
      r.Total = f4(total);
      r.TaxTotal = f4(taxTotal);
      r.InvoiceAmountPaid = f4(paid);
      r.InvoiceAmountDue = f4(total - paid);
      r.Description = l.desc;
      r.Quantity = f4(l.qty);
      r.UnitAmount = f4(l.unit);
      r.Discount = l.disc ? f4(l.disc) : '';
      r.LineAmount = f4(l.amount);
      r.AccountCode = STATE.config.accountCode || '200';
      r.TaxType = vatOn ? (STATE.config.xeroTaxVat || 'Standard Rate Sales') : (STATE.config.xeroTaxNoVat || 'No VAT');
      r.TaxAmount = f4(l.tax);
      r.TrackingName1 = STATE.config.xeroTrackingName || 'Sales Rep';
      r.TrackingOption1 = reps;
      r.Currency = STATE.config.currency || 'ZAR';
      r.Type = 'Sales invoice';
      r.Sent = 'Unsent';
      r.Status = STATE.invExportStatus || 'Draft';
      return r;
    });
  }

  function exportInvoicesXero(){
    var list = invoicesInRange();
    if(!list.length){ toast('No invoices in that date range'); return; }
    var out = [XERO_INVOICE_COLUMNS.join(',')];
    list.forEach(function(o){
      xeroRowsFor(o).forEach(function(r){ out.push(XERO_INVOICE_COLUMNS.map(function(c){ return csvCell(r[c]); }).join(',')); });
    });
    var csv = out.join('\r\n') + '\r\n';
    var stamp = new Date();
    var rangeTag = (STATE.invExportFrom||STATE.invExportTo) ? ((STATE.invExportFrom||'start')+'_to_'+(STATE.invExportTo||todayIso())+'_') : '';
    var filename = 'SalesInvoices_DsignX_'+rangeTag+todayIso()+'_'+String(stamp.getHours()).padStart(2,'0')+String(stamp.getMinutes()).padStart(2,'0')+'.csv';
    var done = function(){ toast('Exported '+list.length+' invoice'+(list.length===1?'':'s')); };
    if(STATE.downloads){
      STATE.downloads.save({filename:filename, data:csv}).then(done).catch(function(e){
        if(e && e.code==='declined'){ toast('Export cancelled'); } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
      });
    } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
  }

  function invExportPresets(){
    var now = new Date(), y = now.getFullYear(), m = now.getMonth();
    var dow = (now.getDay()+6)%7; // Monday = 0
    var monday = new Date(y, m, now.getDate()-dow);
    var sunday = new Date(y, m, now.getDate()-dow+6);
    var taxStart = new Date(m>=2 ? y : y-1, 2, 1); // SA tax year starts 1 March
    return [
      {label:'All dates', from:'', to:''},
      {label:'Today', from:todayIso(), to:todayIso()},
      {label:'This week', from:localIso(monday), to:localIso(sunday)},
      {label:'This month', from:localIso(new Date(y,m,1)), to:localIso(new Date(y,m+1,0))},
      {label:'Last month', from:localIso(new Date(y,m-1,1)), to:localIso(new Date(y,m,0))},
      {label:'Tax year to date', from:localIso(taxStart), to:todayIso()}
    ];
  }

  function renderLetterheadPanel(){
    function f(id, key, label){ return '<div class="field"><label for="'+id+'">'+label+'</label><input type="text" id="'+id+'" value="'+escapeHtml(lh(key))+'"></div>'; }
    return (
      '<div class="panel">' +
        '<div class="section-label">Letterhead on quotes &amp; invoices</div>' +
        '<div class="hint" style="margin:-4px 0 12px;">Printed in the header, banking box and footer of every quote and invoice PDF. VAT number and bank details come from Invoice defaults below.</div>' +
        f('lhName','docCompanyName','Company name') +
        f('lhAddress','docAddress','Address') +
        '<div class="field-row">' + f('lhTel','docTel','Telephone') + f('lhWa','docWhatsapp','WhatsApp') + '</div>' +
        '<div class="field-row">' + f('lhEmail','docEmail','Email') + f('lhWeb','docWebsite','Website') + '</div>' +
        '<div class="field-row">' + f('lhReg','docRegNo','Company reg. no') + f('lhSwift','bankSwift','SWIFT code') + '</div>' +
        f('lhAcctType','bankAccountType','Bank account type') +
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
          '<button class="btn btn-primary btn-sm" data-action="save-letterhead">Save</button>' +
          '<button class="btn btn-sm" data-action="preview-letterhead" data-kind="quote">Sample quote PDF</button>' +
          '<button class="btn btn-sm" data-action="preview-letterhead" data-kind="invoice">Sample invoice PDF</button>' +
        '</div>' +
      '</div>'
    );
  }

  function sampleDocOrder(){
    return {id:'sample01', customerName:'Sample Customer', phone:'+27 82 000 0000', title:'Shopfront fascia sign', description:'3m x 0.6m light box fascia with existing logo artwork.',
      lineItems:[{description:'Light box fascia sign 3m x 0.6m', qty:1, unitPrice:3650},{description:'Installation', qty:1, unitPrice:550}],
      invoiceLineItems:[{description:'Light box fascia sign 3m x 0.6m', qty:1, unitPrice:3650},{description:'Installation', qty:1, unitPrice:550}],
      quoteNumber:'QU-SAMPLE', invoiceNumber:'INV-SAMPLE', quoteGeneratedAt:todayIso(), invoiceGeneratedAt:todayIso(),
      quoteVatEnabled:true, invoiceVatEnabled:true, quoteValidDays:STATE.config.quoteValidityDays||14, invoiceDueDays:STATE.config.invoiceDueDays||7};
  }

  /* ============================ customer export (Xero contacts template) ============================ */
  var XERO_CONTACT_COLUMNS = ['*ContactName','AccountNumber','EmailAddress','FirstName','LastName','POAttentionTo','POAddressLine1','POAddressLine2','POAddressLine3','POAddressLine4','POCity','PORegion','POPostalCode','POCountry','SAAttentionTo','SAAddressLine1','SAAddressLine2','SAAddressLine3','SAAddressLine4','SACity','SARegion','SAPostalCode','SACountry','PhoneNumber','FaxNumber','MobileNumber','DDINumber','SkypeName','BankAccountName','BankAccountNumber','BankAccountParticulars','TaxNumber','AccountsReceivableTaxCodeName','AccountsPayableTaxCodeName','Website','LegalName','Discount','CompanyNumber','DueDateBillDay','DueDateBillTerm','DueDateSalesDay','DueDateSalesTerm','SalesAccount','PurchasesAccount','TrackingName1','SalesTrackingOption1','PurchasesTrackingOption1','TrackingName2','SalesTrackingOption2','PurchasesTrackingOption2','BrandingTheme','DefaultTaxBills','DefaultTaxSales','Person1FirstName','Person1LastName','Person1Email','Person1IncludeInEmail','Person2FirstName','Person2LastName','Person2Email','Person2IncludeInEmail','Person3FirstName','Person3LastName','Person3Email','Person3IncludeInEmail','Person4FirstName','Person4LastName','Person4Email','Person4IncludeInEmail','Person5FirstName','Person5LastName','Person5Email','Person5IncludeInEmail'];

  function ordersOfCustomer(c){
    var n = String(c.name||'').trim().toLowerCase();
    return STATE.orders.filter(function(o){ return o.customerId===c.id || (!o.customerId && String(o.customerName||'').trim().toLowerCase()===n); });
  }
  // When the customer was added. Older records have no date, so fall back to their first job.
  function customerAddedDate(c){
    if(c.createdAt) return String(c.createdAt).slice(0,10);
    var ds = ordersOfCustomer(c).map(function(o){ return String(o.createdAt||'').slice(0,10); }).filter(Boolean).sort();
    return ds[0] || '';
  }
  function customerActivityDates(c){
    var out = [];
    ordersOfCustomer(c).forEach(function(o){
      if(o.createdAt) out.push(String(o.createdAt).slice(0,10));
      if(isSale(o)) out.push(invoiceDateOf(o));
    });
    return out;
  }
  function customersForExport(){
    var from = STATE.custExportFrom, to = STATE.custExportTo;
    if(from && to && from > to){ var t = from; from = to; to = t; }
    var dated = !!(from || to);
    function inRange(d){ return !!d && (!from || d >= from) && (!to || d <= to); }
    var undated = 0;
    var list = STATE.customers.filter(function(c){
      if(!dated) return true;
      if(STATE.custExportMode==='active') return customerActivityDates(c).some(inRange);
      var d = customerAddedDate(c);
      if(!d){ undated++; return false; }
      return inRange(d);
    }).slice().sort(function(a,b){ return String(a.name||'').localeCompare(String(b.name||'')); });
    return {list:list, undated:undated};
  }
  function exportCustomersXero(){
    var res = customersForExport(), list = res.list;
    if(!list.length){ toast('No customers in that date range'); return; }
    var out = [XERO_CONTACT_COLUMNS.join(',')];
    list.forEach(function(c){
      var r = {};
      XERO_CONTACT_COLUMNS.forEach(function(k){ r[k] = ''; });
      r['*ContactName'] = String(c.name||'').trim();
      r.EmailAddress = c.email || '';
      r.FirstName = c.firstName || '';
      r.LastName = c.lastName || '';
      r.MobileNumber = c.phone || '';
      var pa = c.postalAddress || {}, da = customerDeliveryAddress(c) || {};
      r.POAddressLine1 = pa.line1||''; r.POAddressLine2 = pa.line2||''; r.POCity = pa.city||''; r.PORegion = pa.region||''; r.POPostalCode = pa.postalCode||''; r.POCountry = addrHasData(pa) ? (pa.country||'') : '';
      r.SAAddressLine1 = da.line1||''; r.SAAddressLine2 = da.line2||''; r.SACity = da.city||''; r.SARegion = da.region||''; r.SAPostalCode = da.postalCode||''; r.SACountry = addrHasData(da) ? (da.country||'') : '';
      if(c.type==='business'){
        r.Website = c.website || '';
        r.TaxNumber = c.vatNumber || '';
        r.CompanyNumber = c.regNumber || '';
        r.LegalName = String(c.name||'').trim();
        (c.contacts||[]).slice(0,5).forEach(function(p, i){
          var n = i+1;
          r['Person'+n+'FirstName'] = p.firstName||''; r['Person'+n+'LastName'] = p.lastName||''; r['Person'+n+'Email'] = p.email||'';
          r['Person'+n+'IncludeInEmail'] = p.email ? 'Yes' : '';
        });
      }
      out.push(XERO_CONTACT_COLUMNS.map(function(k){ return csvCell(r[k]); }).join(','));
    });
    var csv = out.join('\r\n') + '\r\n';
    var tag = (STATE.custExportFrom||STATE.custExportTo) ? ((STATE.custExportFrom||'start')+'_to_'+(STATE.custExportTo||todayIso())+'_') : '';
    var filename = 'Contacts_DsignX_'+tag+todayIso()+'.csv';
    var done = function(){ toast('Exported '+list.length+' customer'+(list.length===1?'':'s')); };
    if(STATE.downloads){
      STATE.downloads.save({filename:filename, data:csv}).then(done).catch(function(e){
        if(e && e.code==='declined'){ toast('Export cancelled'); } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
      });
    } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
  }
  function renderCustomerExportPanel(){
    var res = customersForExport(), list = res.list;
    var withEmail = list.filter(function(c){ return c.email; }).length;
    var withPhone = list.filter(function(c){ return c.phone; }).length;
    var dated = !!(STATE.custExportFrom || STATE.custExportTo);
    return (
      '<div class="panel">' +
        '<div class="section-label">Export customers (Xero contacts template)</div>' +
        '<div class="hint" style="margin:-4px 0 12px;">One row per customer in the same 73 columns as your Xero “Contacts” import file. Fills in contact name, primary person, email, cellphone, postal and delivery addresses, and for businesses the website, registration number, VAT number and up to 5 contact persons.</div>' +
        '<div class="section-label" style="margin-bottom:6px;">Dates</div>' +
        '<div class="filterbar" style="margin-bottom:10px;">' + invExportPresets().map(function(p){
          var on = STATE.custExportFrom===p.from && STATE.custExportTo===p.to;
          return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="cust-ex-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>';
        }).join('') + '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="custExFrom">From</label><input type="date" id="custExFrom" value="'+escapeHtml(STATE.custExportFrom)+'"></div>' +
          '<div class="field"><label for="custExTo">To</label><input type="date" id="custExTo" value="'+escapeHtml(STATE.custExportTo)+'"></div>' +
        '</div>' +
        '<div class="field"><label for="custExMode">Include customers who</label><select id="custExMode" style="max-width:320px;"'+(dated?'':' disabled')+'>' +
          '<option value="added"'+(STATE.custExportMode==='added'?' selected':'')+'>were added in these dates</option>' +
          '<option value="active"'+(STATE.custExportMode==='active'?' selected':'')+'>had a job or invoice in these dates</option>' +
        '</select></div>' +
        '<div style="background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px; font-size:12.5px; color:var(--ink-soft); margin-bottom:12px;">' +
          (list.length ? ('<strong style="color:var(--ink);">'+list.length+' customer'+(list.length===1?'':'s')+'</strong> &middot; '+withPhone+' with a phone number &middot; '+withEmail+' with an email') : 'No customers match these dates.') +
          (res.undated ? ('<div style="margin-top:4px;">'+res.undated+' older customer'+(res.undated===1?' has':'s have')+' no date on record and no jobs, so '+(res.undated===1?'it isn’t':'they aren’t')+' included. Choose <em>All dates</em> to export everyone.</div>') : '') +
        '</div>' +
        '<button class="btn btn-primary btn-sm" data-action="export-customers-xero"'+(list.length?'':' disabled')+'>Download CSV</button>' +
      '</div>'
    );
  }

  function renderInvoiceExportPanel(){
    var list = invoicesInRange();
    var lineCount = 0, grand = 0;
    list.forEach(function(o){ var rows = xeroRowsFor(o); lineCount += rows.length; grand += Number(rows[0] ? rows[0].Total : 0); });
    var statusOpts = ['Draft','Awaiting Approval','Awaiting Payment'].map(function(v){ return '<option'+(STATE.invExportStatus===v?' selected':'')+'>'+v+'</option>'; }).join('');
    var dates = list.map(invoiceDateOf);
    return (
      '<div class="panel">' +
        '<div class="section-label">Export invoices (Xero sales invoice template)</div>' +
        '<div class="hint" style="margin:-4px 0 12px;">Every invoice issued in the app, one row per line item, in the same 44 columns as your Xero “SalesInvoices” file. Amounts are excl. VAT per line with VAT in TaxAmount; designer &amp; technician go in the Sales Rep tracking column.</div>' +
        '<div class="section-label" style="margin-bottom:6px;">Invoice dates to export</div>' +
        '<div class="filterbar" style="margin-bottom:10px;">' + invExportPresets().map(function(p){
          var on = STATE.invExportFrom===p.from && STATE.invExportTo===p.to;
          return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="inv-ex-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>';
        }).join('') + '</div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="invExFrom">From</label><input type="date" id="invExFrom" value="'+escapeHtml(STATE.invExportFrom)+'"></div>' +
          '<div class="field"><label for="invExTo">To</label><input type="date" id="invExTo" value="'+escapeHtml(STATE.invExportTo)+'"></div>' +
        '</div>' +
        '<div class="field"><label for="invExStatus">Import into Xero as</label><select id="invExStatus" style="max-width:220px;">'+statusOpts+'</select></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="cfgXeroTaxVat">Tax type (with VAT)</label><input type="text" id="cfgXeroTaxVat" value="'+escapeHtml(STATE.config.xeroTaxVat||'Standard Rate Sales')+'"></div>' +
          '<div class="field"><label for="cfgXeroTaxNoVat">Tax type (no VAT)</label><input type="text" id="cfgXeroTaxNoVat" value="'+escapeHtml(STATE.config.xeroTaxNoVat||'No VAT')+'"></div>' +
        '</div>' +
        '<div class="field"><label for="cfgXeroTracking">Tracking category name</label><input type="text" id="cfgXeroTracking" style="max-width:220px;" value="'+escapeHtml(STATE.config.xeroTrackingName||'Sales Rep')+'"><div class="hint">Account code ('+escapeHtml(STATE.config.accountCode||'200')+') and currency come from Xero export defaults on this page.</div></div>' +
        '<div style="background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px; font-size:12.5px; color:var(--ink-soft); margin-bottom:12px;">' +
          (list.length ? ('<strong style="color:var(--ink);">'+list.length+' invoice'+(list.length===1?'':'s')+'</strong> &middot; '+lineCount+' line'+(lineCount===1?'':'s')+' &middot; '+money(round2(grand))+' incl. VAT &middot; '+shortDate(dates[0])+' – '+shortDate(dates[dates.length-1])) : ((STATE.invExportFrom||STATE.invExportTo) ? ('No invoices dated '+(STATE.invExportFrom?fullDate(STATE.invExportFrom):'the start')+' – '+(STATE.invExportTo?fullDate(STATE.invExportTo):'today')+'.') : 'No invoices issued yet.')) +
        '</div>' +
        '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
          '<button class="btn btn-primary btn-sm" data-action="export-invoices-xero"'+(list.length?'':' disabled')+'>Download CSV</button>' +
          '<button class="btn btn-sm" data-action="save-xero-export-defaults">Save tax &amp; tracking</button>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ team ============================ */
  function toggleCashupPermission(id, on){
    if(!isOwnerRole()) return;
    var m = STATE.team.find(function(x){ return x.id===id; }); if(!m) return;
    if(STATE.isLive && STATE.db){
      STATE.db.doc('team/'+id).update({canCashup:!!on}).then(function(){ toast(m.name+(on?' can now do cash-ups':' can no longer do cash-ups')); })
        .catch(function(){ toast('Could not save — try again'); render(); });
    } else { m.canCashup = !!on; render(); toast(m.name+(on?' can now do cash-ups':' can no longer do cash-ups')); }
  }
  // A job can have a designer and up to two technicians.
  function onJob(o, id){ return !!id && (o.designerId===id || o.technicianId===id || o.technician2Id===id); }
  function isTechOn(o, id){ return !!id && (o.technicianId===id || o.technician2Id===id); }
  function isUnassigned(o){ return !o.designerId && !o.technicianId && !o.technician2Id; }
  function techNames(o){ return [o.technicianName, o.technician2Name].filter(Boolean).join(' & '); }
  function jobCountFor(memberId){
    return STATE.orders.filter(function(o){
      return onJob(o, memberId) && o.status!=='collected';
    }).length;
  }

  function renderTeamTab(){
    var groups = TEAM_ROLES.map(function(r){
      var members = STATE.team.filter(function(m){ return m.role===r.key; });
      var rows = members.length ? members.map(function(m){
        var openCount = jobCountFor(m.id);
        var linked = linksFor(m.id).length;
        var inviteStatus;
        if(m.active===false){ inviteStatus = '<span class="access-tag access-off">Access revoked</span>'; }
        else if(linked>1){ inviteStatus = '<span class="access-tag access-warn" title="More than one account used this invite code — reset access if that wasn’t expected">'+linked+' accounts linked</span>'; }
        else if(linked===1){ inviteStatus = '<span class="access-tag access-on">Has access</span>'; }
        else if(m.inviteHash){ inviteStatus = '<span class="access-tag '+(m.inviteExpires && m.inviteExpires<todayIso()?'access-off">Code expired':'access-pending">Code sent '+shortDate(m.invitedAt))+'</span>'; }
        else { inviteStatus = '<span class="access-tag access-off">No access yet</span>'; }
        if(!isOwnerRole()){ inviteStatus = ''; }
        var panel = STATE.inviteMemberId===m.id ? renderInvitePanel(m) : '';
        return (
          '<div>' +
          '<div class="customer-row">' +
            '<div><div class="nm">'+escapeHtml(m.name)+'</div><div class="ph">'+escapeHtml(m.phone||m.email||'no contact on file')+'</div></div>' +
            '<div class="ct">'+openCount+' open job'+(openCount===1?'':'s')+'<br>' +
              '<span style="font-size:11px; color:var(--ink-faint);">'+roleLabel(m.role)+'</span>' +
              (isOwnerRole() ? (
              '<br>'+inviteStatus+'<br>' +
              '<button class="btn btn-ghost btn-sm" style="padding:2px 8px; margin-top:2px;" data-action="invite-team" data-id="'+m.id+'">'+((linksFor(m.id).length||m.inviteHash)?'New code':'Invite')+'</button> ' +
              ((linksFor(m.id).length||m.inviteHash) ? '<button class="btn btn-ghost btn-sm" style="padding:2px 8px; margin-top:2px;" data-action="revoke-team" data-id="'+m.id+'">Revoke</button> ' : '') +
              '<button class="btn btn-ghost btn-sm" style="padding:2px 8px; margin-top:2px;" data-action="delete-team" data-id="'+m.id+'">Remove</button>' +
              '<br><label class="perm-toggle"><input type="checkbox" data-action="team-cashup" data-id="'+m.id+'"'+(m.canCashup?' checked':'')+'> Can do cash-ups</label>') : (m.canCashup ? '<br><span style="font-size:11px; color:var(--ink-faint);">Does cash-ups</span>' : '')) +
            '</div>' +
          '</div>' +
          panel +
          '</div>'
        );
      }).join('') : '<div class="empty-note">No '+r.plural.toLowerCase()+' added yet.</div>';
      return '<div class="panel"><div class="panel-head"><h2>'+r.plural+'</h2></div><div class="customer-list">'+rows+'</div></div>';
    }).join('');

    return (
      '<div class="topline"><div><h1>Team</h1><div class="sub">Designers and technicians you assign jobs to'+(isOwnerRole()?'':' &middot; only the owner can invite or remove people')+'</div></div>' + exampleBadge() +
        (isOwnerRole() ? '<button class="btn btn-primary" data-action="open-add-team">+ Add team member</button>' : '') +
      '</div>' +
      (isOwnerRole() ? renderAccessPanel() : '') +
      groups
    );
  }

  function renderAccessPanel(){
    var row = function(label, o, d, t){ var y = '<span style="color:var(--success); font-weight:700;">✓</span>', n = '<span style="color:var(--ink-faint);">—</span>'; return '<tr><td>'+label+'</td><td>'+(o?y:n)+'</td><td>'+(d?y:n)+'</td><td>'+(t?y:n)+'</td></tr>'; };
    return (
      '<div class="panel"><div class="panel-head"><h2>Access &amp; security</h2></div>' +
        '<div class="hint" style="margin:-4px 0 12px; font-size:12.5px;">To give someone access: 1) add them below, 2) tap <strong>Invite</strong> to send the website link and their one-time code. They create their own account (email and password) with the code. Codes expire after '+CODE_TTL_DAYS+' days. Everyone is signed out after 30 minutes without activity, or when they close the tab. <strong>Revoke</strong> signs a person out immediately.</div>' +
        '<div class="tbl-wrap"><table class="perm-table"><thead><tr><th>Section</th><th>Owner</th><th>Designer</th><th>Technician</th></tr></thead><tbody>' +
          row('Job board', 1,1,1) + row('Dashboard', 1,1,0) + row('WhatsApp inbox', 1,1,0) + row('Customers', 1,1,0) + row('Quotes &amp; invoicing', 1,1,0) + row('Receive payments &amp; issue receipts', 1,1,0) + '<tr><td>Cash-ups</td><td><span style="color:var(--success); font-weight:700;">✓</span></td><td colspan="2" style="font-size:12px;">Only people ticked “Can do cash-ups” below</td></tr>' + row('Void a receipt / reopen a cash-up', 1,0,0) + row('Reports (designers see only their own commission)', 1,1,0) + row('Team (view)', 1,1,0) + row('Invite / revoke people', 1,0,0) + row('Settings', 1,0,0) +
        '</tbody></table></div>' +
        '<div class="hint" style="margin-top:8px;">Technicians see job cards without prices and can’t delete jobs, create orders, or open quotes and invoices.</div>' +
      '</div>' +
      '<div class="panel"><div class="panel-head"><h2>App link for invites</h2></div>' +
        '<div class="field"><label for="cfgAppLink">Link your team opens to use DsignX Ops</label>' +
          '<input type="text" id="cfgAppLink" placeholder="'+escapeHtml(location.origin+location.pathname)+'" value="'+escapeHtml(STATE.config.appShareLink||'')+'"><div class="hint">Leave empty to use this page’s address.</div>' +
          '<div class="hint">Make sure you\'ve shared this page with them first — use the Share button on DsignX Ops itself — otherwise the link won\'t open for them.</div>' +
        '</div>' +
        '<button class="btn btn-primary btn-sm" data-action="save-team-defaults">Save</button>' +
      '</div>'
    );
  }

  function renderInvitePanel(m){
    var text = STATE.inviteDraftText || inviteMessageFor(m, STATE.inviteCode);
    var canWhatsapp = !!(waPhone(m.phone) && STATE.mcp);
    return (
      '<div class="panel invite-panel">' +
        '<div class="section-label">One-time invite code for '+escapeHtml(m.name)+'</div>' +
        '<div class="code-box">'+escapeHtml(STATE.inviteCode||'')+'</div>' +
        '<div class="hint" style="margin:-6px 0 12px;">The code becomes active when you send or copy the message'+(linksFor(m.id).length?' — and their current sign-in stops working':'')+'.</div>' +
        '<div class="field"><label for="inviteMsg">Invite message for '+escapeHtml(m.name)+'</label><textarea id="inviteMsg" rows="5">'+escapeHtml(text)+'</textarea></div>' +
        (canWhatsapp ? '' : '<div class="hint">'+(waPhone(m.phone) ? 'WhatsApp isn\'t connected right now' : 'Add a phone number to send this via WhatsApp')+' — copy the message instead and send it however suits.</div>') +
        '<div class="modal-foot" style="justify-content:flex-start;">' +
          (canWhatsapp ? '<button class="btn btn-primary btn-sm" data-action="invite-send-wa" data-id="'+m.id+'">Send via WhatsApp</button>' : '') +
          '<button class="btn btn-sm" data-action="invite-copy" data-id="'+m.id+'">Copy message</button>' +
          '<button class="btn btn-ghost btn-sm" data-action="invite-cancel">Cancel</button>' +
        '</div>' +
      '</div>'
    );
  }

  function renderNewTeamModal(){
    var roleOpts = TEAM_ROLES.map(function(r){ return '<option value="'+r.key+'">'+r.label+'</option>'; }).join('');
    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Add team member" style="max-width:420px;">' +
          '<div class="modal-head"><h2>Add team member</h2><button class="modal-close" data-action="close-new-team" aria-label="Close">&times;</button></div>' +
          '<div class="field"><label for="ntName">Name</label><input type="text" id="ntName" placeholder="e.g. Thabo Nkosi"></div>' +
          '<div class="field"><label for="ntRole">Role</label><select id="ntRole">'+roleOpts+'</select></div>' +
          '<div class="field"><label for="ntPhone">Phone (optional)</label><input type="tel" id="ntPhone" placeholder="+27..."></div>' +
          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="close-new-team">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-new-team">Add to team</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function assigneeSelects(order, prefix){
    order = order || {};
    prefix = prefix || 'of';
    function optionsFor(role, selectedId){
      var opts = '<option value="">Unassigned</option>';
      var opt = function(m){ return '<option value="'+m.id+'" '+(selectedId===m.id?'selected':'')+'>'+escapeHtml(m.name)+'</option>'; };
      var active = STATE.team.filter(function(m){ return m.active!==false || m.id===selectedId; });
      var main = active.filter(function(m){ return m.role===role; });
      if(role!=='technician') return opts + main.map(opt).join('');
      // Technicians first; anyone else on the team can also be put on a job as a technician.
      var others = active.filter(function(m){ return m.role!=='technician'; });
      opts += main.length ? '<optgroup label="Technicians">'+main.map(opt).join('')+'</optgroup>' : '';
      opts += others.length ? '<optgroup label="Other team members">'+others.map(opt).join('')+'</optgroup>' : '';
      return opts;
    }
    return (
      '<div class="field-row">' +
        '<div class="field"><label for="'+prefix+'AsgDesigner">Designer</label><select id="'+prefix+'AsgDesigner">'+optionsFor('designer', order.designerId)+'</select></div>' +
        '<div class="field"><label for="'+prefix+'AsgTechnician">Technician</label><select id="'+prefix+'AsgTechnician">'+optionsFor('technician', order.technicianId)+'</select></div>' +
        '<div class="field"><label for="'+prefix+'AsgTechnician2">Second technician</label><select id="'+prefix+'AsgTechnician2">'+optionsFor('technician', order.technician2Id)+'</select></div>' +
      '</div>'
    );
  }

  /* ============================ customers ============================ */
  function renderCustomersTab(){
    var q = STATE.customerQuery.trim().toLowerCase();
    var list = STATE.customers.filter(function(c){ return !q || c.name.toLowerCase().indexOf(q)>=0 || (c.phone||'').indexOf(q)>=0; });

    var rows = list.length ? list.map(function(c){
      var os = STATE.orders.filter(function(o){ return o.customerId===c.id; });
      var total = os.reduce(function(s,o){ return s+(Number(o.quoteAmount)||0); },0);
      return (
        '<div class="customer-row" data-action="view-customer" data-id="'+c.id+'">' +
          '<div><div class="nm">'+escapeHtml(c.name)+(c.type==='business'?'<span class="cust-type">Business</span>':'')+'</div><div class="ph">'+escapeHtml(c.phone||'no number on file')+'</div></div>' +
          '<div class="ct">'+os.length+' job'+(os.length===1?'':'s')+'<br>'+money(total)+'</div>' +
        '</div>'
      );
    }).join('') : '<div class="empty-note">No customers yet — they\'ll appear here as soon as you log a job.</div>';

    var detail = '';
    if(STATE.viewCustomerId){
      var c = STATE.customers.find(function(x){return x.id===STATE.viewCustomerId;});
      if(c){
        var os = STATE.orders.filter(function(o){ return o.customerId===c.id; });
        var hist = os.length ? os.map(function(o){
          return '<tr class="row-btn" data-action="open-order" data-id="'+o.id+'"><td>'+escapeHtml(o.title)+'</td><td><span class="status-chip status-'+o.status+'">'+statusMeta(o.status).label+'</span></td><td class="num">'+(o.quoteAmount?money(o.quoteAmount):'—')+'</td><td>'+shortDate(o.createdAt)+'</td></tr>';
        }).join('') : '<tr><td colspan="4" class="empty-note">No jobs logged yet.</td></tr>';
        detail =
          '<div class="panel">' +
            '<div class="panel-head"><h2>'+escapeHtml(c.name)+'<span class="cust-type">'+(c.type==='business'?'Business':'Individual')+'</span></h2><div style="display:flex; gap:6px;"><button class="btn btn-sm" data-action="edit-customer" data-id="'+c.id+'">Edit</button><button class="btn btn-ghost btn-sm" data-action="close-customer">Close</button></div></div>' +
            '<dl class="kv" style="margin-bottom:14px;">' +
              (personName(c)?('<dt>Primary person</dt><dd>'+escapeHtml(personName(c))+'</dd>'):'') +
              '<dt>Cellphone</dt><dd class="mono">'+escapeHtml(c.phone||'—')+'</dd>' +
              (c.email?('<dt>Email</dt><dd>'+escapeHtml(c.email)+'</dd>'):'') +
              (c.website?('<dt>Website</dt><dd>'+escapeHtml(c.website)+'</dd>'):'') +
              (c.regNumber?('<dt>Reg. number</dt><dd class="mono">'+escapeHtml(c.regNumber)+'</dd>'):'') +
              (c.vatNumber?('<dt>VAT number</dt><dd class="mono">'+escapeHtml(c.vatNumber)+'</dd>'):'') +
              (addrHasData(c.postalAddress)?('<dt>Postal</dt><dd class="addr">'+escapeHtml(formatAddress(c.postalAddress))+'</dd>'):'') +
              (addrHasData(customerDeliveryAddress(c))?('<dt>Delivery</dt><dd class="addr">'+(c.deliverySame===false?escapeHtml(formatAddress(c.deliveryAddress)):'Same as postal')+'</dd>'):'') +
              ((c.contacts||[]).length?('<dt>Contacts</dt><dd>'+(c.contacts||[]).map(function(p){ return escapeHtml([personName(p), p.phone, p.email].filter(Boolean).join(' · ')); }).join('<br>')+'</dd>'):'') +
              (c.notes?('<dt>Notes</dt><dd>'+escapeHtml(c.notes)+'</dd>'):'') +
            '</dl>' +
            '<div class="tbl-wrap"><table><thead><tr><th>Job</th><th>Status</th><th>Quote</th><th>Logged</th></tr></thead><tbody>'+hist+'</tbody></table></div>' +
          '</div>';
      }
    }

    return (
      '<div class="topline"><div><h1>Customers</h1><div class="sub">'+STATE.customers.length+' on file</div></div>' + exampleBadge() +
        '<button class="btn btn-primary" data-action="open-add-customer">+ Add customer</button>' +
      '</div>' +
      '<div class="two-col">' +
        '<div>' +
          '<div class="search" style="margin-bottom:12px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg><input type="text" id="customerSearch" placeholder="Search customers" value="'+escapeHtml(STATE.customerQuery)+'"></div>' +
          '<div class="customer-list">'+rows+'</div>' +
        '</div>' +
        '<div>'+(detail || '<div class="panel"><div class="empty-note">Select a customer to see their order history.</div></div>')+'</div>' +
      '</div>'
    );
  }

  /* ============================ quotes & invoicing ============================ */
  function renderQuotesTab(){
    var list = STATE.orders.filter(function(o){ return o.quoteOnly || (o.quoteAmount!==null && o.quoteAmount!==undefined && o.quoteAmount!==''); });
    if(STATE.quoteFilter==='quoteonly') list = list.filter(function(o){ return o.quoteOnly; });
    if(STATE.quoteFilter==='pending') list = list.filter(function(o){ return !o.invoiced; });
    if(STATE.quoteFilter==='invoiced') list = list.filter(function(o){ return o.invoiced; });
    list = list.slice().sort(function(a,b){ return (b.updatedAt||'').localeCompare(a.updatedAt||''); });

    var selectedCount = Object.keys(STATE.selectedForExport).filter(function(k){ return STATE.selectedForExport[k]; }).length;

    var rows = list.length ? list.map(function(o){
      var checked = !!STATE.selectedForExport[o.id];
      return (
        '<tr>' +
          '<td><input type="checkbox" data-action="select-export" data-id="'+o.id+'" '+(checked?'checked':'')+'></td>' +
          '<td class="row-btn" data-action="'+(o.quoteOnly?'open-quote':'open-order')+'" data-id="'+o.id+'">'+escapeHtml(o.customerName)+'</td>' +
          '<td class="row-btn" data-action="'+(o.quoteOnly?'open-quote':'open-order')+'" data-id="'+o.id+'">'+escapeHtml(o.title)+(o.quoteOnly ? ' <span class="pay-chip quote-only-chip">Quote only</span>' : (o.jobNumber ? '<div class="mono" style="font-size:11px; color:var(--ink-faint);">'+escapeHtml(o.jobNumber)+'</div>' : ''))+'</td>' +
          '<td class="num">'+money(o.quoteAmount||0)+'</td>' +
          '<td>'+(o.quoteOnly ? '<button class="btn btn-ghost btn-sm" data-action="quote-convert" data-id="'+o.id+'">Convert to job</button>' : o.invoiced ? ('<span class="status-chip status-invoiced">'+escapeHtml(o.invoiceNumber||'Invoiced')+'</span>') : '<button class="btn btn-ghost btn-sm" data-action="open-invoice" data-id="'+o.id+'">Generate</button>')+'</td>' +
          '<td>'+shortDate(o.dueDate)+'</td>' +
          '<td>'+(o.quoteNumber ? ('<span class="mono" style="font-size:11.5px;">'+escapeHtml(o.quoteNumber)+'</span>') : '<button class="btn btn-ghost btn-sm" data-action="open-quote" data-id="'+o.id+'">Generate</button>')+'</td>' +
          '<td>'+(o.quoteOnly ? '<span style="color:var(--ink-faint);">—</span>' : '')+(o.quoteOnly ? '' : (function(){ var st = payStatus(o); return '<span class="pay-chip pay-'+st.key+'">'+st.label+'</span>'; })())+'</td>' +
        '</tr>'
      );
    }).join('') : '<tr><td colspan="8" class="empty-note">No quotations yet — use “+ New quotation”, or set a quote amount on any job card.</td></tr>';

    return (
      '<div class="topline"><div><h1>Quotes &amp; invoicing</h1><div class="sub">Quote a customer without opening a job, or export selected jobs as a Xero-ready invoice CSV</div></div>' + exampleBadge() +
        '<button class="btn btn-primary" data-action="open-new-quote">+ New quotation</button>' +
      '</div>' +
      '<div class="filterbar" style="margin-bottom:14px;">' +
        '<button class="chip-toggle '+(STATE.quoteFilter==='all'?'active':'')+'" data-action="quote-filter" data-filter="all">All</button>' +
        '<button class="chip-toggle '+(STATE.quoteFilter==='quoteonly'?'active':'')+'" data-action="quote-filter" data-filter="quoteonly">Quotes only (no job yet)</button>' +
        '<button class="chip-toggle '+(STATE.quoteFilter==='pending'?'active':'')+'" data-action="quote-filter" data-filter="pending">Not yet invoiced</button>' +
        '<button class="chip-toggle '+(STATE.quoteFilter==='invoiced'?'active':'')+'" data-action="quote-filter" data-filter="invoiced">Invoiced</button>' +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-primary btn-sm" data-action="export-xero" '+(selectedCount?'':'disabled')+'>Export '+(selectedCount||'')+' to Xero CSV</button>' +
      '</div>' +
      '<div class="panel"><div class="tbl-wrap"><table><thead><tr><th></th><th>Customer</th><th>Job</th><th>Amount</th><th>Invoice</th><th>Due</th><th>Quotation</th><th>Payment</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>' +
      '<div class="hint" style="margin-top:10px;">Xero import needs the <strong>ContactName</strong> to match an existing Xero contact exactly, and every line filled in for AccountCode and TaxType — set your defaults in Settings.</div>'
    );
  }

  /* ============================ settings ============================ */
  function waMediaCheckHtml(){
    var c = STATE.waMediaCheck;
    if(!c || c.status==='loading') return '';
    if(c.status==='error'){
      return '<div class="hint" style="margin-top:8px; color:var(--critical);">Could not check — '+escapeHtml(waErrorNotice(c.error).text)+'</div>';
    }
    return '<div class="hint" style="margin-top:8px;">' + c.rows.map(function(r){
      return escapeHtml(r.name)+': <strong>'+(r.ok?'connected':'not set up')+'</strong>'+(r.ok?'':' — add its key on the server (see the setup guide)');
    }).join('<br>') + '</div>';
  }

  function renderSettingsTab(){
    var num = (STATE.config.whatsappNumber||'').replace(/\D/g,'');
    var msg = STATE.config.messageTemplate || DEFAULT_TEMPLATE;
    var link = num ? ('https://wa.me/'+num+'?text='+encodeURIComponent(msg)) : '';

    return (
      '<div class="topline"><div><h1>Settings</h1><div class="sub">WhatsApp ordering &amp; invoicing defaults</div></div></div>' +
      '<div class="two-col">' +
        '<div>' +
          '<div class="panel">' +
            '<div class="section-label">WhatsApp ordering</div>' +
            '<div class="field"><label for="waNumber">Business WhatsApp number</label><input type="tel" id="waNumber" placeholder="27821112222" value="'+escapeHtml(STATE.config.whatsappNumber||'')+'"><div class="hint">Country code, digits only — no leading 0 or plus sign needed.</div></div>' +
            '<div class="field"><label for="waTemplate">Pre-filled order message</label><textarea id="waTemplate" rows="7">'+escapeHtml(msg)+'</textarea></div>' +
            '<button class="btn btn-primary btn-sm" data-action="save-whatsapp">Save</button>' +
            '<div style="margin-top:16px;">' +
              (link ?
                ('<label>Share this link — post it in your Instagram bio, website or storefront</label>' +
                '<div class="search" style="margin-bottom:8px;"><input type="text" readonly value="'+escapeHtml(link)+'" id="waLink"></div>' +
                '<div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-sm" data-action="copy-link">Copy link</button><a class="btn btn-sm btn-primary" href="'+escapeHtml(link)+'" target="_blank" rel="noopener">Open in WhatsApp</a></div>')
                : '<div class="hint">Add a WhatsApp number above to generate your order link.</div>'
              ) +
            '</div>' +
          '</div>' +
          '<div class="panel" style="padding:12px 14px;"><span class="hint" style="margin:0;">Invoice, credit note, customer and receipt downloads (and the Xero export defaults) are on the <button type="button" class="btn btn-ghost btn-sm" style="padding:0 4px; vertical-align:baseline;" data-action="tab" data-tab="exports">Exports</button> tab.</span></div>' +
          (isOwnerRole() ? renderReminderPanel() : '') +
          renderLetterheadPanel() +
          '<div class="panel">' +
            '<div class="section-label">Quotation defaults</div>' +
            '<div class="field-row">' +
              '<div class="field"><label for="cfgBizEmail">Business email (optional)</label><input type="text" id="cfgBizEmail" value="'+escapeHtml(STATE.config.businessEmail||'')+'"></div>' +
              '<div class="field"><label for="cfgBizAddress">Business address (optional)</label><input type="text" id="cfgBizAddress" value="'+escapeHtml(STATE.config.businessAddress||'')+'"></div>' +
            '</div>' +
            '<div class="field-row">' +
              '<div class="field"><label for="cfgValidDays">Default validity (days)</label><input type="number" id="cfgValidDays" min="1" value="'+(STATE.config.quoteValidityDays||14)+'"></div>' +
              '<div class="field"><label for="cfgVatRate">VAT rate (%)</label><input type="number" id="cfgVatRate" min="0" step="0.1" value="'+(STATE.config.vatRate!=null?STATE.config.vatRate:15)+'"></div>' +
            '</div>' +
            '<div class="field"><label for="cfgQuoteTerms">Default terms &amp; notes</label><textarea id="cfgQuoteTerms" rows="3">'+escapeHtml(STATE.config.quoteTerms||'')+'</textarea></div>' +
            '<button class="btn btn-primary btn-sm" data-action="save-quote-defaults">Save</button>' +
          '</div>' +
          '<div class="panel">' +
            '<div class="section-label">Invoice defaults</div>' +
            '<div class="field"><label for="cfgVatNumber">Business VAT number</label><input type="text" id="cfgVatNumber" value="'+escapeHtml(STATE.config.businessVatNumber||'')+'"><div class="hint">Leave blank if you\'re not VAT-registered — invoices will then say &ldquo;Invoice&rdquo; with no VAT charged, never &ldquo;Tax Invoice&rdquo;.</div></div>' +
            '<div class="field"><label for="cfgInvoiceDueDays">Default payment terms (days)</label><input type="number" id="cfgInvoiceDueDays" min="0" style="max-width:110px" value="'+(STATE.config.invoiceDueDays||7)+'"></div>' +
            '<div class="section-label" style="margin-top:14px;">Banking details (printed on invoices, optional)</div>' +
            '<div class="field-row">' +
              '<div class="field"><label for="cfgBankName">Bank</label><input type="text" id="cfgBankName" value="'+escapeHtml(STATE.config.bankName||'')+'"></div>' +
              '<div class="field"><label for="cfgBankHolder">Account holder</label><input type="text" id="cfgBankHolder" value="'+escapeHtml(STATE.config.bankAccountHolder||'')+'"></div>' +
            '</div>' +
            '<div class="field-row">' +
              '<div class="field"><label for="cfgBankAccount">Account number</label><input type="text" id="cfgBankAccount" value="'+escapeHtml(STATE.config.bankAccountNumber||'')+'"></div>' +
              '<div class="field"><label for="cfgBankBranch">Branch code</label><input type="text" id="cfgBankBranch" value="'+escapeHtml(STATE.config.bankBranchCode||'')+'"></div>' +
            '</div>' +
            '<div class="field"><label for="cfgInvoiceTerms">Default terms &amp; notes</label><textarea id="cfgInvoiceTerms" rows="3">'+escapeHtml(STATE.config.invoiceTerms||'')+'</textarea></div>' +
            '<button class="btn btn-primary btn-sm" data-action="save-invoice-defaults">Save</button>' +
          '</div>' +
          (isOwnerRole() ?
            '<div class="panel">' +
              '<div class="section-label">Import data</div>' +
              '<p class="hint" style="margin-top:0;">Load a DsignX Ops backup file (.json), for example the export from the Claude version. Records with the same ID are overwritten; nothing else is deleted. Team members must be invited again afterwards.</p>' +
              (STATE.importStatus ? '<div class="hint" style="margin:0 0 8px;"><strong>'+escapeHtml(STATE.importStatus)+'</strong></div>' : '') +
              '<label class="btn btn-sm" style="cursor:pointer;">Choose backup file…<input type="file" id="importFile" accept="application/json,.json" style="display:none"></label>' +
            '</div>'
            : '') +
          (STATE.mcp ?
            '<div class="panel">' +
              '<div class="section-label">Sending files over WhatsApp</div>' +
              '<p class="hint" style="margin-top:0;">Messages go out from the business number '+escapeHtml(waFrom())+' through Bird. Quotes, invoices and artwork are uploaded to Cloudinary so WhatsApp can fetch them, and are deleted from Cloudinary after 30 days. Use <strong>Send via WhatsApp</strong>, review the preview in that job\'s chat and hit Send. WhatsApp only allows normal messages and files within 24 hours of the customer\'s last message to you.</p>' +
              '<button class="btn btn-sm" data-action="wa-check-media" '+((STATE.waMediaCheck&&STATE.waMediaCheck.status==='loading')?'disabled':'')+'>'+((STATE.waMediaCheck&&STATE.waMediaCheck.status==='loading')?'Checking…':'Check WhatsApp connection')+'</button>' +
              waMediaCheckHtml() +
            '</div>'
            : '') +
        '</div>' +
        '<div>' +
          '<div class="section-label">What a customer sees</div>' +
          '<div class="phone-mock"><div class="bubble">'+escapeHtml(msg)+'</div></div>' +
          '<p class="hint" style="max-width:280px;">Tapping the link opens WhatsApp with this message ready to send to your number — the customer fills in the blanks and hits send. When they message you, log the job with <strong>+ New order</strong> so it lands on your board.</p>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ quote modal ============================ */
  function renderQuoteModal(){
    var o = STATE.orders.find(function(x){ return x.id===STATE.quoteModalOrderId; });
    var draft = STATE.quoteDraft;
    if(!o || !draft) return '';
    var totals = quoteTotals(draft);

    var rows = draft.items.map(function(li, i){
      return (
        '<tr>' +
          '<td style="min-width:180px;"><input type="text" id="qliDesc-'+i+'" list="productOptions" autocomplete="off" value="'+escapeHtml(li.description)+'" placeholder="Type or pick a product"></td>' +
          '<td style="width:64px;"><input type="number" id="qliQty-'+i+'" min="0" step="1" value="'+li.qty+'"></td>' +
          '<td style="width:100px;"><input type="number" id="qliPrice-'+i+'" min="0" step="0.01" value="'+li.unitPrice+'"></td>' +
          '<td style="width:74px;"><input type="number" id="qliDisc-'+i+'" min="0" max="100" step="0.01" placeholder="0" value="'+(lineDiscPct(li)||'')+'" title="Line discount %"></td>' +
          '<td class="num" id="qliLineTotal-'+i+'" style="white-space:nowrap;">'+money(lineNet(li))+'</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-action="quote-remove-line" data-i="'+i+'" title="Remove line">&times;</button></td>' +
        '</tr>' +
        '<tr class="li-note-row"><td colspan="6"><textarea id="qliNote-'+i+'" rows="1" class="li-note" placeholder="Notes for this item (optional) — printed under it on the PDF">'+escapeHtml(li.note||'')+'</textarea></td></tr>'
      );
    }).join('');

    var validUntil = addDays(todayIso(), draft.validDays);

    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Quotation" style="max-width:680px;">' +
          '<div class="modal-head"><div><div class="jobno mono">'+(o.quoteNumber||'Not yet numbered')+'</div><h2>Quotation for '+escapeHtml(o.customerName)+'</h2></div><button class="modal-close" data-action="close-quote-modal" aria-label="Close">&times;</button></div>' +

          '<div class="tbl-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Disc %</th><th>Line total</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
          '<button class="btn btn-ghost btn-sm" style="margin:8px 0 16px;" data-action="quote-add-line">+ Add line</button>' + productDatalist() +

          '<div class="kv" style="justify-content:flex-end; margin-left:auto; max-width:260px; margin-bottom:16px;">' +
            '<dt>Subtotal</dt><dd class="num" id="qSubtotal">'+money(totals.subtotal)+'</dd>' +
            '<dt><label style="display:flex; align-items:center; gap:6px; margin:0; cursor:pointer;"><input type="checkbox" id="qVatEnabled" style="width:auto;" '+(draft.vatEnabled?'checked':'')+'> VAT ('+(STATE.config.vatRate||15)+'%)</label></dt><dd class="num" id="qVatAmount">'+money(totals.vat)+'</dd>' +
            '<dt style="font-weight:700; color:var(--ink);">Total</dt><dd class="num" id="qTotal" style="font-weight:700;">'+money(totals.total)+'</dd>' +
          '</div>' +

          '<div class="field-row">' +
            '<div class="field"><label for="qValidDays">Valid for (days)</label><input type="number" id="qValidDays" min="1" value="'+draft.validDays+'"></div>' +
            '<div class="field"><label>Valid until</label><input type="text" id="qValidUntilDisplay" value="'+fullDate(validUntil)+'" disabled></div>' +
          '</div>' +
          '<div class="field"><label for="qTerms">Terms &amp; notes (printed on the quote)</label><textarea id="qTerms" rows="3">'+escapeHtml(draft.terms)+'</textarea></div>' +

          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="close-quote-modal">Cancel</button>' +
            (o.quoteOnly ? '<button class="btn btn-ghost" data-action="quote-convert" data-id="'+o.id+'" title="Put this on the job board">Convert to job</button>' : '') +
            '<button class="btn" data-action="quote-save" data-id="'+o.id+'">Save</button>' +
            '<button class="btn" data-action="quote-save-download" data-id="'+o.id+'">Save &amp; download PDF</button>' +
            (waPhone(o.phone) ? '<button class="btn btn-primary" data-action="quote-save-whatsapp" data-id="'+o.id+'">Save &amp; send via WhatsApp</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ invoice modal ============================ */
  function renderInvoiceModal(){
    var o = STATE.orders.find(function(x){ return x.id===STATE.invoiceModalOrderId; });
    var draft = STATE.invoiceDraft;
    if(!o || !draft) return '';
    var vendor = isVatVendor();
    var totals = invoiceTotals(draft);

    var rows = draft.items.map(function(li, i){
      return (
        '<tr>' +
          '<td style="min-width:180px;"><input type="text" id="iliDesc-'+i+'" list="productOptions" autocomplete="off" value="'+escapeHtml(li.description)+'" placeholder="Type or pick a product"></td>' +
          '<td style="width:64px;"><input type="number" id="iliQty-'+i+'" min="0" step="1" value="'+li.qty+'"></td>' +
          '<td style="width:100px;"><input type="number" id="iliPrice-'+i+'" min="0" step="0.01" value="'+li.unitPrice+'"></td>' +
          '<td style="width:74px;"><input type="number" id="iliDisc-'+i+'" min="0" max="100" step="0.01" placeholder="0" value="'+(lineDiscPct(li)||'')+'" title="Line discount %"></td>' +
          '<td class="num" id="iliLineTotal-'+i+'" style="white-space:nowrap;">'+money(lineNet(li))+'</td>' +
          '<td><button class="btn btn-ghost btn-sm" data-action="invoice-remove-line" data-i="'+i+'" title="Remove line">&times;</button></td>' +
        '</tr>' +
        '<tr class="li-note-row"><td colspan="6"><textarea id="iliNote-'+i+'" rows="1" class="li-note" placeholder="Notes for this item (optional) — printed under it on the PDF">'+escapeHtml(li.note||'')+'</textarea></td></tr>'
      );
    }).join('');

    var dueDate = addDays(todayIso(), draft.dueDays);

    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Invoice" style="max-width:680px;">' +
          '<div class="modal-head"><div><div class="jobno mono">'+(o.invoiceNumber||'Not yet numbered')+'</div><h2>'+(vendor?'Tax invoice':'Invoice')+' for '+escapeHtml(o.customerName)+'</h2></div><button class="modal-close" data-action="close-invoice-modal" aria-label="Close">&times;</button></div>' +

          (vendor ? '' : '<p class="hint" style="margin-top:0;">No business VAT number is on file in Settings, so this will be issued as a plain invoice with no VAT charged — not a Tax Invoice.</p>') +

          '<div class="tbl-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Disc %</th><th>Line total</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
          '<button class="btn btn-ghost btn-sm" style="margin:8px 0 16px;" data-action="invoice-add-line">+ Add line</button>' + productDatalist() +

          '<div class="kv" style="justify-content:flex-end; margin-left:auto; max-width:260px; margin-bottom:16px;">' +
            '<dt>Subtotal</dt><dd class="num" id="iSubtotal">'+money(totals.subtotal)+'</dd>' +
            (vendor ?
              '<dt><label style="display:flex; align-items:center; gap:6px; margin:0; cursor:pointer;"><input type="checkbox" id="iVatEnabled" style="width:auto;" '+(draft.vatEnabled?'checked':'')+'> VAT ('+(STATE.config.vatRate||15)+'%)</label></dt><dd class="num" id="iVatAmount">'+money(totals.vat)+'</dd>'
              : '') +
            '<dt style="font-weight:700; color:var(--ink);">Total due</dt><dd class="num" id="iTotal" style="font-weight:700;">'+money(totals.total)+'</dd>' +
          '</div>' +

          '<div class="field-row">' +
            '<div class="field"><label for="iDueDays">Payment due in (days)</label><input type="number" id="iDueDays" min="0" value="'+draft.dueDays+'"></div>' +
            '<div class="field"><label>Due date</label><input type="text" id="iDueDateDisplay" value="'+fullDate(dueDate)+'" disabled></div>' +
          '</div>' +
          '<div class="field"><label for="iTerms">Terms &amp; notes (printed on the invoice)</label><textarea id="iTerms" rows="3">'+escapeHtml(draft.terms)+'</textarea></div>' +

          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="close-invoice-modal">Cancel</button>' +
            '<button class="btn" data-action="invoice-save" data-id="'+o.id+'">Save</button>' +
            '<button class="btn" data-action="invoice-save-download" data-id="'+o.id+'">Save &amp; download PDF</button>' +
            (waPhone(o.phone) ? '<button class="btn btn-primary" data-action="invoice-save-whatsapp" data-id="'+o.id+'">Save &amp; send via WhatsApp</button>' : '') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ order modal ============================ */
  function renderChatSection(o){
    if(!STATE.mcp){
      return '<div class="section-label" style="margin-top:18px;">Customer chat</div><div class="hint">WhatsApp isn’t set up on the server yet, so customer chat is unavailable.</div>';
    }
    var phone = waPhone(o.phone);
    if(!phone){
      return '<div class="section-label" style="margin-top:18px;">Customer chat</div><div class="hint">No phone number on file for this customer.</div>';
    }
    var entry = STATE.chatMessages[phone] || {};
    var body;
    if(entry.loading && !(entry.list && entry.list.length)){
      body = '<div class="empty-note">Loading conversation…</div>';
    } else if(entry.error && !(entry.list && entry.list.length)){
      var notice = waErrorNotice(entry.error);
      body = '<div class="wa-status error">'+escapeHtml(notice.text)+(notice.action?(' '+escapeHtml(notice.action)):'')+'</div>';
    } else if(entry.list && entry.list.length){
      body = '<div class="chat-thread">' + entry.list.map(function(m){
        var cls = m.from_me ? 'out' : 'in';
        return '<div class="chat-msg '+cls+'">'+escapeHtml(m.body||'(no text — open WhatsApp to view)')+(m.media ? waMediaButtons(m.media, true) : '')+'<span class="t">'+relTime(m.date)+(m.failed?(' · <span style="color:var(--critical);">not delivered'+(m.failReason?(': '+escapeHtml(m.failReason)):'')+'</span>'):'')+'</span></div>';
      }).join('') + '</div>';
    } else {
      body = '<div class="empty-note">No WhatsApp messages with this customer yet.</div>';
    }

    var composeArea;
    if(entry.uploading){
      composeArea = '<div class="chat-preview">Preparing the file for WhatsApp…</div>';
    } else if(entry.pendingSend){
      var pv = entry.pendingSend;
      var previewLine = pv.kind==='template'
        ? ('<strong>Template: '+escapeHtml(pv.label)+'</strong><br><em>&ldquo;'+escapeHtml(pv.text)+'&rdquo;</em>')
        : (!pv.kind || pv.kind==='text')
        ? '<em>&ldquo;'+escapeHtml(pv.text)+'&rdquo;</em>'
        : ('📎 <strong>'+escapeHtml(pv.filename)+'</strong>' + (pv.caption ? ('<br><em>&ldquo;'+escapeHtml(pv.caption)+'&rdquo;</em>') : ''));
      composeArea =
        '<div class="chat-preview">Send to '+escapeHtml(o.customerName)+' (+'+escapeHtml(phone)+')?<br>'+previewLine+
          (pv.kind!=='template' && !waWindowOpen(phone) && !entry.loading && !entry.sendError ? '<div style="margin-top:6px; color:var(--warning, #9a6700);">This customer hasn\'t messaged you in the last 24 hours, so WhatsApp will probably refuse this. Ask them to send you a message first.</div>' : '') +
          (entry.sendError ? ('<div style="margin-top:6px; color:var(--critical);">'+escapeHtml(waErrorNotice(entry.sendError).text)+'</div>') : '') +
          '<div class="actions">' +
            '<button class="btn btn-primary btn-sm" data-action="chat-confirm-send" data-phone="'+phone+'" '+(entry.sending?'disabled':'')+'>'+(entry.sending?'Sending…':'Send now')+'</button>' +
            '<button class="btn btn-ghost btn-sm" data-action="chat-cancel-send" data-phone="'+phone+'" '+(entry.sending?'disabled':'')+'>Cancel</button>' +
          '</div>' +
        '</div>';
    } else {
      var draft = STATE.chatDraft[phone] || '';
      composeArea =
        (!waWindowOpen(phone) && !entry.loading && !(entry.list && entry.list.length) ? '<div class="hint" style="margin-bottom:6px;">No WhatsApp chat with this customer yet (e.g. a walk-in). Start with the <strong>Walk-in customer</strong> template below — once they reply, you can send quotes, proofs and files here.</div>' : '') +
        (!waWindowOpen(phone) && !entry.loading && (entry.list && entry.list.length) ? '<div class="hint" style="margin-bottom:6px;">The 24-hour reply window is closed. Send an approved template to restart the conversation; once the customer replies you can chat normally again.</div>' : '') +
        templatePicker(phone) +
        '<div class="chat-compose">' +
          '<label class="btn btn-sm chat-attach" title="Attach a photo, PDF or document" aria-label="Attach a file">'+CLIP_ICON+'<input type="file" id="chatAttach" data-phone="'+phone+'" accept="image/jpeg,image/png,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" style="display:none"></label>' +
          '<textarea id="chatCompose" placeholder="Message '+escapeHtml(o.customerName)+'…" rows="2">'+escapeHtml(draft)+'</textarea>' +
          '<button class="btn btn-primary btn-sm" data-action="chat-prepare-send" data-phone="'+phone+'">Send</button>' +
        '</div>';
    }

    return (
      '<div class="section-label" style="margin-top:18px; display:flex; align-items:center; justify-content:space-between;">Customer chat<button class="btn btn-ghost btn-sm" style="margin:0; padding:3px 9px;" data-action="chat-refresh" data-phone="'+phone+'">Refresh</button></div>' +
      body + composeArea
    );
  }

  function renderOrderModal(){
    var o = STATE.orders.find(function(x){return x.id===STATE.openOrderId;});
    if(!o) return '';
    var statusOpts = o.quoteOnly ? '<option value="quote" selected>Quotation only (not a job yet)</option>' : STATUSES.map(function(s){ return '<option value="'+s.key+'" '+(o.status===s.key?'selected':'')+'>'+s.label+'</option>'; }).join('');
    var catOpts = CATEGORIES.map(function(c){ return '<option value="'+c.key+'" '+(o.category===c.key?'selected':'')+'>'+c.label+'</option>'; }).join('');
    var attach = (o.attachmentIds||[]).map(function(id){
      return '<div class="attach-item" style="position:relative; display:inline-block;">' +
        '<img class="attach-thumb" src="'+escapeHtml(id)+'" alt="Attachment">' +
        (waPhone(o.phone) ? '<button class="btn btn-sm" style="position:absolute; bottom:4px; right:4px; padding:2px 7px; font-size:11px;" title="Send via WhatsApp" data-action="send-artwork-wa" data-id="'+o.id+'" data-att="'+id+'">Send</button>' : '') +
      '</div>';
    }).join('');

    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="Job details">' +
          '<div class="modal-head"><div><div class="jobno mono">'+(o.quoteOnly ? 'Quotation only' : jobNo(o.id))+'</div><h2>'+escapeHtml(o.title)+'</h2></div><button class="modal-close" data-action="close-order" aria-label="Close">&times;</button></div>' +
          (o.quoteOnly ? quoteOnlyBanner(o) : '') +
          '<div class="field-row">' +
            '<div class="field" style="flex:2;"><label for="ofTitle">Job title</label><input type="text" id="ofTitle" value="'+escapeHtml(o.title)+'"></div>' +
            '<div class="field"><label for="ofPo">Customer PO number</label><input type="text" id="ofPo" autocomplete="off" placeholder="'+(isTechnician()?'':'Optional')+'" value="'+escapeHtml(o.poNumber||'')+'"'+(isTechnician()?' disabled':'')+'></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="ofStatus">Status</label><select id="ofStatus">'+statusOpts+'</select></div>' +
            '<div class="field"><label for="ofCategory">Category</label><select id="ofCategory">'+catOpts+'</select></div>' +
          '</div>' +
          '<div class="field"><label for="ofCustomer">Customer</label><input type="text" value="'+escapeHtml(o.customerName)+' &middot; '+escapeHtml(o.phone||'no number')+'" disabled></div>' +
          '<div class="field"><label for="ofDesc">Details</label><textarea id="ofDesc">'+escapeHtml(o.description||'')+'</textarea></div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="ofOrderDate">Order date</label><input type="date" id="ofOrderDate" value="'+orderDateOf(o)+'"'+(isOwnerRole()?'':' disabled title="Only the owner can change the order date"')+'></div>' +
            '<div class="field"><label for="ofQty">Quantity</label><input type="number" id="ofQty" min="1" value="'+(o.qty||1)+'"></div>' +
            '<div class="field"><label for="ofDue">Due date</label><input type="date" id="ofDue" value="'+(o.dueDate||'')+'"></div>' +
          '</div>' +
          assigneeSelects(o) +
          (isTechnician() ? '' : (
          '<div class="field-row">' +
            '<div class="field"><label for="ofQuote">Quote amount ('+escapeHtml(STATE.config.currency||'ZAR')+')</label><input type="number" id="ofQuote" step="0.01" value="'+(o.quoteAmount!==null&&o.quoteAmount!==undefined?o.quoteAmount:'')+'"></div>' +
            '<div class="field"><label for="ofInvNo">Invoice number</label><input type="text" id="ofInvNo" value="'+escapeHtml(o.invoiceNumber||'')+'" placeholder="'+jobNo(o.id)+'"></div>' +
          '</div>' +
          '<div class="field" style="display:flex; align-items:center; justify-content:space-between; background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px;">' +
            '<span style="font-size:12.5px; color:var(--ink-soft);">'+(o.quoteNumber ? ('Quotation '+escapeHtml(o.quoteNumber)+' &middot; '+(o.lineItems?o.lineItems.length:0)+' line item'+((o.lineItems&&o.lineItems.length===1)?'':'s')) : 'No quotation document yet')+'</span>' +
            '<button class="btn btn-sm" data-action="open-quote" data-id="'+o.id+'">'+(o.quoteNumber?'Edit quotation':'Generate quotation')+'</button>' +
          '</div>' +
          '<div class="field" style="display:flex; align-items:center; justify-content:space-between; background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px;">' +
            '<span style="font-size:12.5px; color:var(--ink-soft);">'+(o.invoiceNumber && o.invoiceGeneratedAt ? ((isVatVendor()?'Tax invoice ':'Invoice ')+escapeHtml(o.invoiceNumber)+' &middot; '+(o.invoiceLineItems?o.invoiceLineItems.length:0)+' line item'+((o.invoiceLineItems&&o.invoiceLineItems.length===1)?'':'s')) : 'No invoice document yet')+'</span>' +
            '<button class="btn btn-sm" data-action="open-invoice" data-id="'+o.id+'">'+(o.invoiceNumber && o.invoiceGeneratedAt?'Edit invoice':'Generate tax invoice')+'</button>' +
          '</div>'
          )) +
          (isTechnician() ? '' : renderPaymentsSection(o)) +
          '<div class="field"><label for="ofNotes">Internal notes</label><textarea id="ofNotes">'+escapeHtml(o.notes||'')+'</textarea>' +
            '<button type="button" class="btn btn-ghost btn-sm" style="margin-top:6px;" data-action="msg-new-job" data-id="'+o.id+'">Send a task or enquiry about this job</button></div>' +
          (STATE.assets ?
            '<div class="field"><label>Artwork / proof attachments</label><div class="attach-grid">'+attach+'<label class="attach-file" style="cursor:pointer;">+ Add<input type="file" id="ofAttach" accept="image/*,application/pdf" style="display:none"></label></div></div>'
            : (attach ? '<div class="field"><label>Artwork / proof attachments</label><div class="attach-grid">'+attach+'</div></div>' : '')
          ) +
          (isTechnician() ? '' : '<label style="display:flex; align-items:center; gap:8px; margin:4px 0 6px; cursor:pointer;"><input type="checkbox" id="ofInvoiced" '+(o.invoiced?'checked':'')+' style="width:auto;"> Marked as invoiced</label>') +
          (isTechnician() ? '' : renderChatSection(o)) +
          '<div class="modal-foot">' +
            (isTechnician() ? '' : '<button class="btn btn-danger" data-action="delete-order" data-id="'+o.id+'">Delete</button>') +
            '<span style="flex:1"></span>' +
            '<button class="btn btn-ghost" data-action="close-order">Cancel</button>' +
            '<button class="btn btn-primary" data-action="save-order" data-id="'+o.id+'">Save changes</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ new order modal ============================ */
  function quoteOnlyBanner(o){
    return '<div class="hint quote-only-banner">This is a quotation only — it isn’t on the job board and has no job number yet. ' +
      '<button class="btn btn-primary btn-sm" data-action="quote-convert" data-id="'+o.id+'">Convert to job</button> ' +
      '<button class="btn btn-ghost btn-sm" data-action="open-quote" data-id="'+o.id+'">Edit quotation</button></div>';
  }
  function renderNewQuoteModal(){
    var dl = STATE.customers.map(function(c){ return '<option value="'+escapeHtml(c.name)+'">'; }).join('');
    var catOpts = CATEGORIES.map(function(c){ return '<option value="'+c.key+'">'+c.label+'</option>'; }).join('');
    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="New quotation" style="max-width:480px;">' +
          '<div class="modal-head"><h2>New quotation</h2><button class="modal-close" data-action="close-new-quote" aria-label="Close">&times;</button></div>' +
          '<div class="hint" style="margin:-8px 0 14px;">Quote a customer without opening a job. If they accept, use “Convert to job” to put it on the job board.</div>' +
          '<div class="field"><label for="nqCustomer">Customer name</label><input type="text" id="nqCustomer" list="nqCustomerNames" autocomplete="off" placeholder="e.g. Riaan Pretorius"><datalist id="nqCustomerNames">'+dl+'</datalist></div>' +
          '<div class="field"><label for="nqPhone">Phone number (for WhatsApp)</label><input type="tel" id="nqPhone" placeholder="Filled in for existing customers"></div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="nqTitle">What is it for?</label><input type="text" id="nqTitle" placeholder="e.g. A1 banners x4"></div>' +
            '<div class="field"><label for="nqCategory">Category</label><select id="nqCategory">'+catOpts+'</select></div>' +
          '</div>' +
          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="close-new-quote">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-new-quote">Next: add items</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }
  function nqCustomerPicked(){
    var el = document.getElementById('nqCustomer'), ph = document.getElementById('nqPhone');
    if(!el || !ph || ph.value) return;
    var c = findCustomerByName(el.value||''); if(c && c.phone) ph.value = c.phone;
  }
  function submitNewQuote(){
    var name = (document.getElementById('nqCustomer').value||'').trim();
    if(!name){ toast('Add a customer name first'); return; }
    var phone = (document.getElementById('nqPhone').value||'').trim();
    var title = (document.getElementById('nqTitle').value||'').trim() || 'Quotation';
    var category = document.getElementById('nqCategory').value;
    var existing = findCustomerByName(name);
    var cp = existing ? Promise.resolve(existing) : persistCustomer({name:name, phone:phone, email:'', notes:''});
    cp.then(function(cust){
      return persistOrder({
        quoteOnly:true, status:'quote', customerId:cust.id, customerName:cust.name, phone:phone || cust.phone || '',
        category:category, title:title, description:'', qty:1, quoteAmount:0, lineItems:[{description:title, qty:1, unitPrice:0}],
        invoiced:false, invoiceNumber:'', dueDate:'', notes:'', source:'Quotation', attachmentIds:[],
        designerId:null, designerName:'', technicianId:null, technicianName:'', technician2Id:null, technician2Name:'',
        createdAt:todayIso(), updatedAt:todayIso()
      });
    }).then(function(o){
      STATE.newQuoteOpen = false;
      if(STATE.orders.indexOf(o)<0 && !STATE.orders.find(function(x){ return x.id===o.id; })) STATE.orders.unshift(o);
      openQuoteModal(o.id);
    }).catch(function(){ toast('Could not create the quotation — try again'); });
  }
  function convertQuoteToJob(id){
    var o = STATE.orders.find(function(x){ return x.id===id; }); if(!o || !o.quoteOnly) return;
    if(!confirm('Convert this quotation for '+(o.customerName||'the customer')+' into a job? It gets a job number and goes on the job board as “Quoted”.')) return;
    reserveNumbers('nextJobNumber', 1).then(function(n){
      var jn = 'DSX-J'+pad4(n);
      return updateOrder(id, {quoteOnly:false, status:'quoted', jobNumber:jn, convertedAt:todayIso(), createdAt:todayIso(), orderDate:todayIso()}).then(function(){ return jn; });
    }).then(function(jn){
      STATE.quoteModalOrderId = null; STATE.quoteDraft = null;
      STATE.openOrderId = id;
      render();
      toast('Job '+jn+' added to the board');
    }).catch(function(){ toast('Could not convert — try again'); });
  }

  function renderNewOrderModal(){
    var pf = STATE.newOrderPrefill || {};
    var catOpts = CATEGORIES.map(function(c){ return '<option value="'+c.key+'">'+c.label+'</option>'; }).join('');
    var srcOpts = SOURCES.map(function(s){ return '<option value="'+s+'" '+((pf.source||'WhatsApp')===s?'selected':'')+'>'+s+'</option>'; }).join('');
    var dl = STATE.customers.map(function(c){ return '<option value="'+escapeHtml(c.name)+'">'; }).join('');
    return (
      '<div class="overlay" data-action="close-modal-bg">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="New order">' +
          '<div class="modal-head"><h2>New order</h2><button class="modal-close" data-action="close-new-order" aria-label="Close">&times;</button></div>' +
          (pf.messageId ? '<div class="hint" style="margin:-8px 0 14px;">Pulled in from WhatsApp — check the details before adding it.</div>' : '') +
          '<div class="field"><label for="noCustomer">Customer name</label><input type="text" id="noCustomer" list="customerNames" placeholder="e.g. Riaan Pretorius" autocomplete="off" value="'+escapeHtml(pf.name||'')+'"><datalist id="customerNames">'+dl+'</datalist></div>' +
          '<div class="field"><label for="noPhone">Phone number</label><input type="tel" id="noPhone" placeholder="+27..." value="'+escapeHtml(pf.phone||'')+'"></div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="noCategory">Category</label><select id="noCategory">'+catOpts+'</select></div>' +
            '<div class="field"><label for="noSource">How did it come in?</label><select id="noSource">'+srcOpts+'</select></div>' +
          '</div>' +
          '<div class="field-row">' +
            '<div class="field" style="flex:2;"><label for="noTitle">Job title</label><input type="text" id="noTitle" placeholder="e.g. Shopfront fascia sign" value="'+escapeHtml(pf.title||'')+'"></div>' +
            '<div class="field"><label for="noPo">Customer PO number</label><input type="text" id="noPo" placeholder="Optional" autocomplete="off" value="'+escapeHtml(pf.poNumber||'')+'"></div>' +
          '</div>' +
          '<div class="field"><label for="noDesc">Details</label><textarea id="noDesc" placeholder="Size, material, files supplied...">'+escapeHtml(pf.description||'')+'</textarea></div>' +
          '<div class="field-row">' +
            '<div class="field"><label for="noOrderDate">Order date</label><input type="date" id="noOrderDate" value="'+todayIso()+'"'+(isOwnerRole()?'':' disabled title="Only the owner can change the order date"')+'></div>' +
            '<div class="field"><label for="noQty">Quantity</label><input type="number" id="noQty" min="1" value="1"></div>' +
            '<div class="field"><label for="noDue">Due date</label><input type="date" id="noDue"></div>' +
          '</div>' +
          '<div class="field"><label for="noQuote">Quote amount ('+escapeHtml(STATE.config.currency||'ZAR')+', optional)</label><input type="number" id="noQuote" step="0.01" placeholder="Leave blank if not quoted yet"></div>' +
          (STATE.team.length ? assigneeSelects({}, 'no') : '') +
          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="close-new-order">Cancel</button>' +
            '<button class="btn btn-primary" data-action="submit-new-order">Add to board</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /* ============================ CSV export ============================ */
  function csvCell(v){
    v = (v===null||v===undefined) ? '' : String(v);
    if(/[",\n]/.test(v)) v = '"' + v.replace(/"/g,'""') + '"';
    return v;
  }
  function exportXero(){
    var ids = Object.keys(STATE.selectedForExport).filter(function(k){ return STATE.selectedForExport[k]; });
    var rows = ids.map(function(id){ return STATE.orders.find(function(o){ return o.id===id; }); }).filter(Boolean);
    if(!rows.length){ toast('Select at least one job first'); return; }
    var header = ['ContactName','InvoiceNumber','InvoiceDate','DueDate','Description','Quantity','UnitAmount','AccountCode','TaxType','Currency','Reference'];
    var lines = [header.join(',')];
    rows.forEach(function(o){
      var invNo = o.invoiceNumber || jobNo(o.id);
      lines.push([
        csvCell(o.customerName),
        csvCell(invNo),
        csvCell(todayIso()),
        csvCell(o.dueDate || todayIso()),
        csvCell(o.title + (o.description ? (' — '+o.description) : '')),
        csvCell(o.qty||1),
        csvCell(Number(o.quoteAmount||0).toFixed(2)),
        csvCell(STATE.config.accountCode||''),
        csvCell(STATE.config.taxType||''),
        csvCell(STATE.config.currency||'ZAR'),
        csvCell(o.poNumber ? ('PO '+o.poNumber) : jobNo(o.id))
      ].join(','));
    });
    var csv = lines.join('\r\n');
    var filename = 'dsignx-xero-invoices-'+todayIso()+'.csv';

    function markInvoicedAndReset(){
      rows.forEach(function(o){
        if(!o.invoiced){ var ip = {invoiced:true, invoiceNumber:o.invoiceNumber||jobNo(o.id)}; if(AFTER_INVOICE.indexOf(o.status)<0) ip.status = 'invoiced'; updateOrder(o.id, ip); }
      });
      STATE.selectedForExport = {};
    }

    if(STATE.downloads){
      STATE.downloads.save({filename:filename, data:csv}).then(function(){
        toast('Exported '+rows.length+' job(s) — check your downloads');
        markInvoicedAndReset();
        render();
      }).catch(function(e){
        if(e && e.code==='declined'){ toast('Export cancelled'); }
        else{ toast('Could not export — try again'); }
      });
    } else {
      var blob = new Blob([csv], {type:'text/csv'});
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Exported '+rows.length+' job(s)');
      markInvoicedAndReset();
      render();
    }
  }

  /* ============================ events ============================ */
  function bindEvents(){
    var app = document.getElementById('app');

    app.onclick = function(e){
      var el = e.target.closest('[data-action]');
      if(!el) return;
      var action = el.getAttribute('data-action');

      if(action==='tab'){ if(el.getAttribute('data-tab')!=='whatsapp') STATE.inboxReply = null; var tt = el.getAttribute('data-tab'); if(canAccess(tt)){ STATE.tab = tt; } STATE.viewCustomerId=null; render(); }
      else if(action==='lock-app'){ lockApp(''); }
      else if(action==='cust-ex-preset'){ STATE.custExportFrom = el.getAttribute('data-from'); STATE.custExportTo = el.getAttribute('data-to'); render(); }
      else if(action==='export-customers-xero'){ if(isOwnerRole()) exportCustomersXero(); }
      else if(action==='inv-ex-preset'){ STATE.invExportFrom = el.getAttribute('data-from'); STATE.invExportTo = el.getAttribute('data-to'); render(); }
      else if(action==='save-letterhead' && isOwnerRole()){
        updateConfig({
          docCompanyName: document.getElementById('lhName').value.trim(),
          docAddress: document.getElementById('lhAddress').value.trim(),
          docTel: document.getElementById('lhTel').value.trim(),
          docWhatsapp: document.getElementById('lhWa').value.trim(),
          docEmail: document.getElementById('lhEmail').value.trim(),
          docWebsite: document.getElementById('lhWeb').value.trim(),
          docRegNo: document.getElementById('lhReg').value.trim(),
          bankSwift: document.getElementById('lhSwift').value.trim(),
          bankAccountType: document.getElementById('lhAcctType').value.trim()
        });
        toast('Letterhead saved');
      }
      else if(action==='preview-letterhead'){
        var sk = el.getAttribute('data-kind'), sb = buildBrandedPdf(sk, sampleDocOrder());
        if(sb){ sb.filename = 'Sample-'+sk+'.pdf'; if(STATE.downloads){ STATE.downloads.save({filename:sb.filename, data:sb.blob}).catch(function(err){ if(!err||err.code!=='declined'){ fallbackDownload(sb.blob, sb.filename); } }); } else { fallbackDownload(sb.blob, sb.filename); } }
      }
      else if(action==='export-invoices-xero'){ if(isOwnerRole()) exportInvoicesXero(); }
      else if(action==='save-xero-export-defaults' && isOwnerRole()){
        updateConfig({
          xeroTaxVat: document.getElementById('cfgXeroTaxVat').value.trim() || 'Standard Rate Sales',
          xeroTaxNoVat: document.getElementById('cfgXeroTaxNoVat').value.trim() || 'No VAT',
          xeroTrackingName: document.getElementById('cfgXeroTracking').value.trim() || 'Sales Rep'
        });
        toast('Export settings saved');
      }
      else if(action==='report-month'){
        var rr = reportRange(), base = new Date(rr.from+'T00:00:00');
        var nb = monthBounds(new Date(base.getFullYear(), base.getMonth()+Number(el.getAttribute('data-by')), 1));
        STATE.reportFrom = nb.from; STATE.reportTo = nb.to; STATE.reportOpenMember = null; render();
      }
      else if(action==='wa-media'){ openWaMedia(el); }
      else if(action==='wa-media-dl'){ downloadWaMedia(el); }
      else if(action==='wa-media-save'){ saveWaMediaToJob(el); }
      else if(action==='msg-new'){ openMsgForm(''); }
      else if(action==='msg-new-job'){ var jid = el.getAttribute('data-id'); STATE.openOrderId = null; openMsgForm(jid); }
      else if(action==='msg-form-close'){ STATE.msgForm = null; render(); }
      else if(action==='msg-send'){ sendNewMsg(); }
      else if(action==='msg-box'){ STATE.msgBox = el.getAttribute('data-box'); render(); }
      else if(action==='msg-show'){ STATE.msgShow = el.getAttribute('data-show'); render(); }
      else if(action==='msg-open'){ var mid = el.getAttribute('data-id'); if(STATE.msgOpenId!==mid){ STATE.msgDraft = ''; STATE.msgFiles = []; } STATE.msgOpenId = mid; var mm = (STATE.messages||[]).find(function(x){ return x.id===mid; }); if(mm) clearMsgAttn(mm); render(); var ml = document.querySelector('.msg-detail'); if(ml && window.innerWidth < 900) ml.scrollIntoView({behavior:'smooth'}); }
      else if(action==='msg-close'){ STATE.msgOpenId = null; STATE.msgDraft = ''; render(); }
      else if(action==='msg-act'){ msgAction(el.getAttribute('data-type')); }
      else if(action==='msg-file-remove'){ removeMsgFile(el.getAttribute('data-which'), Number(el.getAttribute('data-i'))); }
      else if(action==='msg-file-save'){ saveMsgFileToJob(el.getAttribute('data-url'), el.getAttribute('data-order')); }
      else if(action==='save-reminders'){ saveReminderSettings(); }
      else if(action==='send-reminders-now'){ sendRemindersNow(); }
      else if(action==='report-pdf'){ commissionReportPdf(); }
      else if(action==='toggle-nav'){ toggleNav(); }
      else if(action==='toggle-collected'){ STATE.showAllCollected = !STATE.showAllCollected; render(); }
      else if(action==='cn-new'){ openCreditForm(el.getAttribute('data-id')); }
      else if(action==='cn-close'){ STATE.creditForm = null; render(); }
      else if(action==='cn-add-line'){ if(STATE.creditForm){ STATE.creditForm.items.push({description:'', qty:1, unitPrice:0, discount:''}); render(); } }
      else if(action==='cn-remove-line'){ if(STATE.creditForm){ STATE.creditForm.items.splice(Number(el.getAttribute('data-i')), 1); render(); } }
      else if(action==='cn-full'){ creditFullBalance(); }
      else if(action==='cn-save'){ saveCreditNote(); }
      else if(action==='cn-pdf'){ downloadCreditNote(el.getAttribute('data-id')); }
      else if(action==='cn-wa'){ sendCreditNoteWhatsapp(el.getAttribute('data-id')); }
      else if(action==='cn-void'){ voidCreditNote(el.getAttribute('data-id')); }
      else if(action==='cn-ex-preset'){ STATE.cnExFrom = el.getAttribute('data-from'); STATE.cnExTo = el.getAttribute('data-to'); render(); }
      else if(action==='export-cn-xero'){ exportCreditNotesXero(); }
      else if(action==='age-toggle'){ var ak = el.getAttribute('data-id'); STATE.ageOpen = STATE.ageOpen===ak ? null : ak; render(); }
      else if(action==='age-today'){ STATE.ageAsAt = todayIso(); render(); }
      else if(action==='age-pdf'){ if(canSeeSalesReports()) ageReportPdf(); }
      else if(action==='age-xlsx'){ if(canSeeSalesReports()) ageReportXlsx(); }
      else if(action==='qs-xlsx'){ if(canSeeSalesReports()) quoteStatsXlsx(); }
      else if(action==='report-view'){ STATE.reportView = el.getAttribute('data-view'); render(); }
      else if(action==='cashrep-pdf'){ cashupReportPdf(); }
      else if(action==='cashrep-xlsx'){ cashupReportXlsx(); }
      else if(action==='cashup-open-day' && canAccess('cashup')){ STATE.tab = 'cashup'; STATE.cashupDate = el.getAttribute('data-date'); STATE.cashupForm = null; render(); }
      else if(action==='report-preset'){ STATE.reportFrom = el.getAttribute('data-from'); STATE.reportTo = el.getAttribute('data-to'); STATE.reportOpenMember = null; render(); }
      else if(action==='report-toggle'){ var rid = el.getAttribute('data-id'); STATE.reportOpenMember = (STATE.reportOpenMember===rid) ? null : rid; render(); }
      else if(action==='report-export'){ if(isOwnerRole()) exportCommissionCsv(); }
      else if(action==='change-password'){ e.preventDefault(); changePassword(); }
      else if(action==='revoke-team'){
        var rm = STATE.team.find(function(x){ return x.id===el.getAttribute('data-id'); });
        if(rm && confirm('Revoke '+rm.name+'’s access? They’ll be signed out and can’t open DsignX Ops until you send a new invite code.')){ revokeAccess(rm.id); }
      }
      else if(action==='open-new-order' && !isTechnician()){ STATE.newOrderPrefill = null; STATE.newOrderOpen = true; render(); }
      else if(action==='close-new-order'){ STATE.newOrderOpen = false; STATE.newOrderPrefill = null; render(); }
      else if(action==='open-order'){
        STATE.openOrderId = el.getAttribute('data-id');
        render();
        var ord = STATE.orders.find(function(x){return x.id===STATE.openOrderId;});
        if(ord && STATE.mcp){ openOrderChat(waPhone(ord.phone)); }
      }
      else if(action==='chat-refresh'){ openOrderChat(el.getAttribute('data-phone')); }
      else if(action==='inbox-reply'){
        var ip = el.getAttribute('data-phone');
        if(STATE.inboxReply && STATE.inboxReply.phone===ip){ STATE.inboxReply = null; render(); }
        else {
          STATE.inboxReply = {phone:ip, name:el.getAttribute('data-name')||'', date:el.getAttribute('data-date')||''};
          var ie = STATE.chatMessages[ip];
          if(!ie || !ie.list) openOrderChat(ip); else render();
          setTimeout(function(){ var t = document.getElementById('chatCompose'); if(t) t.focus(); }, 50);
        }
      }
      else if(action==='chat-prepare-send'){
        var cphone = el.getAttribute('data-phone');
        var ctext = (STATE.chatDraft[cphone]||'').trim();
        if(!ctext){ toast('Type a message first'); return; }
        var centry = STATE.chatMessages[cphone] || {};
        centry.pendingSend = {kind:'text', text:ctext};
        centry.sendError = null;
        STATE.chatMessages[cphone] = centry;
        render();
      }
      else if(action==='chat-confirm-send'){ confirmChatSend(el.getAttribute('data-phone')); }
      else if(action==='chat-cancel-send'){
        var xphone = el.getAttribute('data-phone');
        var xentry = STATE.chatMessages[xphone] || {};
        xentry.pendingSend = null;
        xentry.sendError = null;
        STATE.chatMessages[xphone] = xentry;
        render();
      }
      else if(action==='close-order'){ STATE.openOrderId = null; render(); }
      else if(action==='close-modal-bg'){ if(e.target===el && STATE.newQuoteOpen){ STATE.newQuoteOpen = false; render(); } else if(e.target===el && STATE.receiptForm){ STATE.receiptForm = null; render(); } else if(e.target===el && STATE.creditForm){ STATE.creditForm = null; render(); } else if(e.target===el && STATE.msgForm){ STATE.msgForm = null; render(); } else if(e.target===el){ STATE.openOrderId=null; STATE.newOrderOpen=false; STATE.newOrderPrefill=null; STATE.newTeamOpen=false; STATE.quoteModalOrderId=null; STATE.quoteDraft=null; STATE.invoiceModalOrderId=null; STATE.invoiceDraft=null; render(); } }
      else if(action==='open-add-team'){ if(isOwnerRole()){ STATE.newTeamOpen = true; render(); } }
      else if(action==='close-new-team'){ STATE.newTeamOpen = false; render(); }
      else if(action==='submit-new-team'){ submitNewTeamMember(); }
      else if(action==='delete-team'){
        if(isOwnerRole() && confirm('Remove this team member? They lose access immediately. Jobs already assigned to them keep their name on record.')){ deleteTeamMember(el.getAttribute('data-id')); }
      }
      else if(action==='invite-team'){
        var im = STATE.team.find(function(x){ return x.id===el.getAttribute('data-id'); });
        if(im && isOwnerRole()){
          if(linksFor(im.id).length && !confirm('Send '+im.name+' a new invite code? Their current sign-in stops working until they enter the new code and set a new password.')) return;
          STATE.inviteMemberId = im.id; STATE.inviteCode = generateInviteCode(); STATE.inviteDraftText = inviteMessageFor(im, STATE.inviteCode); render();
        }
      }
      else if(action==='invite-cancel'){ STATE.inviteMemberId = null; STATE.inviteDraftText = ''; STATE.inviteCode = null; render(); }
      else if(action==='invite-copy'){ copyInviteMessage(el.getAttribute('data-id')); }
      else if(action==='invite-send-wa'){ sendTeamInvite(el.getAttribute('data-id')); }
      else if(action==='save-team-defaults' && isOwnerRole()){
        updateConfig({ appShareLink: document.getElementById('cfgAppLink').value.trim() });
        toast('Team invite link saved');
      }
      else if(action==='open-quote'){ if(canAccess('quotes')) openQuoteModal(el.getAttribute('data-id')); }
      else if(action==='close-quote-modal'){ closeQuoteModal(); }
      else if(action==='quote-add-line'){ addQuoteLine(); }
      else if(action==='quote-remove-line'){ removeQuoteLine(Number(el.getAttribute('data-i'))); }
      else if(action==='quote-save'){ saveQuoteDraft(el.getAttribute('data-id'), 'save'); }
      else if(action==='quote-save-download'){ saveQuoteDraft(el.getAttribute('data-id'), 'download'); }
      else if(action==='quote-save-whatsapp'){ saveQuoteDraft(el.getAttribute('data-id'), 'whatsapp'); }
      else if(action==='send-artwork-wa'){ sendArtworkViaWhatsapp(el.getAttribute('data-id'), el.getAttribute('data-att')); }
      else if(action==='wa-check-media'){ checkWaMediaSupport(); }
      else if(action==='save-quote-defaults'){
        updateConfig({
          businessEmail: document.getElementById('cfgBizEmail').value.trim(),
          businessAddress: document.getElementById('cfgBizAddress').value.trim(),
          quoteValidityDays: Number(document.getElementById('cfgValidDays').value)||14,
          vatRate: Number(document.getElementById('cfgVatRate').value)||0,
          quoteTerms: document.getElementById('cfgQuoteTerms').value
        });
        toast('Quotation defaults saved');
      }
      else if(action==='open-invoice'){ if(canAccess('quotes')) openInvoiceModal(el.getAttribute('data-id')); }
      else if(action==='close-invoice-modal'){ closeInvoiceModal(); }
      else if(action==='invoice-add-line'){ addInvoiceLine(); }
      else if(action==='invoice-remove-line'){ removeInvoiceLine(Number(el.getAttribute('data-i'))); }
      else if(action==='invoice-save'){ saveInvoiceDraft(el.getAttribute('data-id'), 'save'); }
      else if(action==='invoice-save-download'){ saveInvoiceDraft(el.getAttribute('data-id'), 'download'); }
      else if(action==='invoice-save-whatsapp'){ saveInvoiceDraft(el.getAttribute('data-id'), 'whatsapp'); }
      else if(action==='save-invoice-defaults'){
        updateConfig({
          businessVatNumber: document.getElementById('cfgVatNumber').value.trim(),
          invoiceDueDays: Number(document.getElementById('cfgInvoiceDueDays').value)||7,
          bankName: document.getElementById('cfgBankName').value.trim(),
          bankAccountHolder: document.getElementById('cfgBankHolder').value.trim(),
          bankAccountNumber: document.getElementById('cfgBankAccount').value.trim(),
          bankBranchCode: document.getElementById('cfgBankBranch').value.trim(),
          invoiceTerms: document.getElementById('cfgInvoiceTerms').value
        });
        toast('Invoice defaults saved');
      }
      else if(action==='wa-refresh'){ waRefreshNow(); }
      else if(action==='log-wa-order'){
        var phone = el.getAttribute('data-phone');
        var msg = STATE.waMessages[phone] || {};
        STATE.newOrderPrefill = {
          name: el.getAttribute('data-name') || phone,
          phone: '+'+phone,
          title: (msg.body||'').slice(0,60) || 'WhatsApp enquiry',
          description: msg.body||'',
          source: 'WhatsApp',
          messageId: el.getAttribute('data-msgid') || null,
          waPhone: phone
        };
        STATE.newOrderOpen = true;
        render();
      }
      else if(action==='dismiss-wa-order' && STATE.inboxReply && STATE.inboxReply.phone===el.getAttribute('data-phone') && !el.getAttribute('data-msgid')){ STATE.inboxReply = null; render(); }
      else if(action==='dismiss-wa-order'){ if(STATE.inboxReply && STATE.inboxReply.phone===el.getAttribute('data-phone')) STATE.inboxReply = null;
        var dphone = el.getAttribute('data-phone'), dmsg = el.getAttribute('data-msgid');
        if(dmsg){ markWaHandled(dphone, dmsg, 'dismissed'); render(); }
      }
      else if(action==='delete-order' && !isTechnician()){
        if(confirm('Delete this job? This cannot be undone.')){ deleteOrder(el.getAttribute('data-id')); }
      }
      else if(action==='save-order'){ saveOrderFromModal(el.getAttribute('data-id')); }
      else if(action==='submit-new-order'){ submitNewOrder(); }
      else if(action==='view-customer'){ STATE.viewCustomerId = el.getAttribute('data-id'); render(); }
      else if(action==='close-customer'){ STATE.viewCustomerId = null; render(); }
      else if(action==='open-add-customer'){ addCustomerPrompt(); }
      else if(action==='edit-customer'){ openCustomerForm(el.getAttribute('data-id')); }
      else if(action==='cf-cancel'){ STATE.customerForm = null; render(); }
      else if(action==='cf-save'){ saveCustomerForm(); }
      else if(action==='cf-type'){ if(STATE.customerForm){ STATE.customerForm.draft.type = el.getAttribute('data-type'); STATE.customerForm.errors = {}; render(); } }
      else if(action==='cf-add-contact'){ var cd = STATE.customerForm && STATE.customerForm.draft; if(cd && cd.contacts.length < MAX_EXTRA_CONTACTS){ cd.contacts.push(blankPerson()); render(); var ni = cd.contacts.length-1; setTimeout(function(){ var x = document.getElementById('cfc'+ni+'f'); if(x) x.focus(); }, 0); } }
      else if(action==='cf-remove-contact'){ var rd = STATE.customerForm && STATE.customerForm.draft; if(rd){ rd.contacts.splice(Number(el.getAttribute('data-i')), 1); render(); } }
      else if(action==='open-new-quote' && canAccess('quotes')){ STATE.newQuoteOpen = true; render(); var nq = document.getElementById('nqCustomer'); if(nq) nq.focus(); }
      else if(action==='close-new-quote'){ STATE.newQuoteOpen = false; render(); }
      else if(action==='submit-new-quote'){ submitNewQuote(); }
      else if(action==='quote-convert' && canAccess('quotes')){ convertQuoteToJob(el.getAttribute('data-id')); }
      else if(action==='quote-filter'){ STATE.quoteFilter = el.getAttribute('data-filter'); render(); }
      else if(action==='product-new'){ STATE.productForm = {code:'', description:'', unit:'', price:''}; render(); }
      else if(action==='product-edit'){ var pe = STATE.products.find(function(x){ return x.id===el.getAttribute('data-id'); }); if(pe){ STATE.productForm = Object.assign({}, pe); render(); } }
      else if(action==='product-cancel'){ STATE.productForm = null; render(); }
      else if(action==='product-save'){ saveProduct(); }
      else if(action==='product-delete'){ deleteProduct(el.getAttribute('data-id')); }
      else if(action==='product-template'){ e.preventDefault(); downloadProductTemplate(); }
      else if(action==='product-import-confirm'){ confirmProductImport(); }
      else if(action==='product-import-cancel'){ STATE.productImport = null; render(); }
      else if(action==='receipt-new'){ openReceiptForm(el.getAttribute('data-id')); }
      else if(action==='receipt-method' && STATE.receiptForm){ STATE.receiptForm.method = el.getAttribute('data-m'); render(); }
      else if(action==='receipt-save'){ saveReceipt(); }
      else if(action==='receipt-close'){ STATE.receiptForm = null; render(); }
      else if(action==='receipt-pdf'){ downloadReceipt(el.getAttribute('data-id')); }
      else if(action==='receipt-wa'){ sendReceiptWhatsapp(el.getAttribute('data-id')); }
      else if(action==='receipt-void'){ voidReceipt(el.getAttribute('data-id')); }
      else if(action==='cashup-save'){ saveCashup(); }
      else if(action==='cashup-reopen'){ reopenCashup(el.getAttribute('data-date')); }
      else if(action==='cashup-csv'){ exportCashupCsv(el.getAttribute('data-date')); }
      else if(action==='receipts-export'){ exportReceiptsCsv(); }
      else if(action==='product-stock-toggle'){ toggleStockItem(el.getAttribute('data-id'), el.checked); }
      else if(action==='stock-tick-all'){ e.preventDefault(); setAllStockItems(true); }
      else if(action==='stock-untick-all'){ e.preventDefault(); setAllStockItems(false); }
      else if(action==='stock-start'){ startStocktake(); }
      else if(action==='stock-sheet'){ saveStockCounts(el.getAttribute('data-id')); downloadCountSheet(el.getAttribute('data-id')); }
      else if(action==='stock-finalise'){ var sid = el.getAttribute('data-id'); clearTimeout(_stockSaveTimer); saveStockCounts(sid).then(function(){ finaliseStocktake(sid); }); }
      else if(action==='stock-cancel'){ cancelStocktake(el.getAttribute('data-id')); }
      else if(action==='stock-variance-pdf'){ var vs = STATE.stocktakes.find(function(x){ return x.id===el.getAttribute('data-id'); }); if(vs) downloadVariancePdf(vs); }
      else if(action==='stock-variance-csv'){ var vc = STATE.stocktakes.find(function(x){ return x.id===el.getAttribute('data-id'); }); if(vc) downloadVarianceCsv(vc); }
      else if(action==='team-cashup'){ toggleCashupPermission(el.getAttribute('data-id'), el.checked); }
      else if(action==='cashup-date'){ STATE.cashupDate = el.getAttribute('data-date'); STATE.cashupForm = null; render(); }
      else if(action==='select-export'){ STATE.selectedForExport[el.getAttribute('data-id')] = el.checked; render(); }
      else if(action==='export-xero'){ exportXero(); }
      else if(action==='save-whatsapp'){
        updateConfig({
          whatsappNumber: document.getElementById('waNumber').value.trim(),
          messageTemplate: document.getElementById('waTemplate').value
        });
        toast('WhatsApp settings saved');
      }
      else if(action==='save-xero-defaults'){
        updateConfig({
          accountCode: document.getElementById('cfgAccount').value.trim(),
          taxType: document.getElementById('cfgTax').value.trim(),
          currency: document.getElementById('cfgCurrency').value.trim() || 'ZAR'
        });
        toast('Xero export defaults saved');
      }
      else if(action==='copy-link'){
        var inp = document.getElementById('waLink');
        copyText(inp.value);
      }
    };

    app.onchange = function(e){
      if(e.target.id==='cfDelSame' && STATE.customerForm){ STATE.customerForm.draft.deliverySame = e.target.checked; render(); return; }
      if(e.target.id==='boardSearch' && STATE.boardQuery!==e.target.value){ STATE.boardQuery = e.target.value; render(); focusEl('boardSearch'); }
      if(e.target.id==='customerSearch'){ STATE.customerQuery = e.target.value; render(); focusEl('customerSearch'); }
      if(e.target.id==='ofAttach'){ handleAttach(e.target.files[0]); }
      if(e.target.id==='chatAttach'){ attachFromDevice(e.target.getAttribute('data-phone'), e.target.files[0]); e.target.value=''; }
      if(e.target.id==='importFile'){ importBackupFile(e.target.files[0]); e.target.value=''; }
      if(e.target.id==='productFile'){ importProductsFile(e.target.files[0]); e.target.value=''; }
      if(e.target.id==='cuDate' && e.target.value){ STATE.cashupDate = e.target.value; STATE.cashupForm = null; render(); }
      if((e.target.id==='rxFrom' || e.target.id==='rxTo') && e.target.value){ STATE[e.target.id] = e.target.value; render(); }
      if(e.target.id==='rxMethod'){ STATE.rxMethod = e.target.value; render(); }
      if(e.target.id==='nqCustomer'){ nqCustomerPicked(); }
      if(e.target.id==='tplPick' && e.target.value){ prepareTemplate(e.target.getAttribute('data-phone'), e.target.value); }
      if(e.target.id==='boardAssignee'){ STATE.boardAssigneeFilter = e.target.value; render(); }
      if(e.target.id==='custExFrom'){ STATE.custExportFrom = e.target.value; render(); }
      if(e.target.id==='custExTo'){ STATE.custExportTo = e.target.value; render(); }
      if(e.target.id==='custExMode'){ STATE.custExportMode = e.target.value; render(); }
      if(e.target.id==='invExFrom'){ STATE.invExportFrom = e.target.value; render(); }
      if(e.target.id==='cnExFrom'){ STATE.cnExFrom = e.target.value; render(); }
      if(e.target.id==='cnExTo'){ STATE.cnExTo = e.target.value; render(); }
      if(e.target.id==='cnExStatus'){ STATE.cnExStatus = e.target.value; render(); }
      if(e.target.id==='msgNewFiles' || e.target.id==='msgReplyFiles'){ onMsgFilesChosen(e.target); return; }
      if(e.target.id==='msgKind'){ var dw = document.getElementById('msgDueWrap'); if(dw) dw.style.display = e.target.value==='task' ? '' : 'none'; if(STATE.msgForm) STATE.msgForm.kind = e.target.value; }
      if(e.target.id==='ageAsAt' && e.target.value){ STATE.ageAsAt = e.target.value; render(); }
      if(e.target.id==='invExTo'){ STATE.invExportTo = e.target.value; render(); }
      if(e.target.id==='invExStatus'){ STATE.invExportStatus = e.target.value; render(); }
      if(e.target.id==='reportFrom'){ STATE.reportFrom = e.target.value; STATE.reportOpenMember = null; render(); }
      if(e.target.id==='reportTo'){ STATE.reportTo = e.target.value; STATE.reportOpenMember = null; render(); }
      if(e.target.id==='qVatEnabled'){ STATE.quoteDraft.vatEnabled = e.target.checked; refreshQuoteTotals(); }
      if(e.target.id==='iVatEnabled'){ STATE.invoiceDraft.vatEnabled = e.target.checked; refreshInvoiceTotals(); }
    };
    app.oninput = function(e){
      var cfp = e.target.getAttribute && e.target.getAttribute('data-cf');
      if(cfp && STATE.customerForm){ setDraftPath(cfp, e.target.value); if(cfp==='name' && STATE.customerForm.errors && STATE.customerForm.errors.name){ STATE.customerForm.errors.name = null; e.target.classList.remove('invalid'); } return; }
      if(e.target.id==='boardSearch' && STATE.boardQuery!==e.target.value){ STATE.boardQuery = e.target.value; render(); focusEl('boardSearch'); }
      if(e.target.id==='customerSearch'){ STATE.customerQuery = e.target.value; render(); focusEl('customerSearch'); }
      if(e.target.id==='msgText'){ STATE.msgDraft = e.target.value; }
      if(e.target.id==='chatCompose'){ var p = currentChatPhone(); if(p){ STATE.chatDraft[p] = e.target.value; } }
      if(e.target.id==='inviteMsg'){ STATE.inviteDraftText = e.target.value; }
      var pfk = e.target.getAttribute && e.target.getAttribute('data-pf'); if(pfk && STATE.productForm){ STATE.productForm[pfk] = e.target.value; }
      var rfk = e.target.getAttribute && e.target.getAttribute('data-rf'); if(rfk && STATE.receiptForm){ STATE.receiptForm[rfk] = e.target.value; }
      if(STATE.creditForm && e.target.getAttribute && (e.target.getAttribute('data-cnf') || e.target.getAttribute('data-cnr'))){ onCreditInput(e.target); }
      var denk = e.target.getAttribute && e.target.getAttribute('data-den'); if(denk){ onDenomInput(denk, e.target.value); }
      var cuk = e.target.getAttribute && e.target.getAttribute('data-cu'); if(cuk && STATE.cashupForm){ STATE.cashupForm[cuk] = e.target.value; refreshCashupTotals(); }
      if(e.target.id==='productSearch'){ STATE.productQuery = e.target.value; render(); focusEl('productSearch'); }
      if(e.target.classList && e.target.classList.contains('st-count')){ onCountInput(e.target.getAttribute('data-st'), e.target.getAttribute('data-pid'), e.target.value); }
      if(e.target.id==='stockSearch'){ STATE.stockQuery = e.target.value; render(); focusEl('stockSearch'); }
      if(STATE.quoteDraft){
        var qm = e.target.id.match(/^qli(Desc|Qty|Price|Disc|Note)-(\d+)$/);
        if(qm){
          var qi = Number(qm[2]);
          var li = STATE.quoteDraft.items[qi];
          if(li){
            if(qm[1]==='Desc'){ li.description = e.target.value; applyProductToLine('qli', qi, STATE.quoteDraft.items); }
            else if(qm[1]==='Qty') li.qty = e.target.value;
            else if(qm[1]==='Price') li.unitPrice = e.target.value;
            else if(qm[1]==='Note') li.note = e.target.value;
            else if(qm[1]==='Disc') li.discount = e.target.value;
            refreshQuoteTotals();
          }
        }
        if(e.target.id==='qValidDays'){
          STATE.quoteDraft.validDays = e.target.value;
          var disp = document.getElementById('qValidUntilDisplay');
          if(disp) disp.value = fullDate(addDays(todayIso(), Number(e.target.value)||0));
        }
        if(e.target.id==='qTerms'){ STATE.quoteDraft.terms = e.target.value; }
      }
      if(STATE.invoiceDraft){
        var im = e.target.id.match(/^ili(Desc|Qty|Price|Disc|Note)-(\d+)$/);
        if(im){
          var ii = Number(im[2]);
          var ili = STATE.invoiceDraft.items[ii];
          if(ili){
            if(im[1]==='Desc'){ ili.description = e.target.value; applyProductToLine('ili', ii, STATE.invoiceDraft.items); }
            else if(im[1]==='Qty') ili.qty = e.target.value;
            else if(im[1]==='Price') ili.unitPrice = e.target.value;
            else if(im[1]==='Note') ili.note = e.target.value;
            else if(im[1]==='Disc') ili.discount = e.target.value;
            refreshInvoiceTotals();
          }
        }
        if(e.target.id==='iDueDays'){
          STATE.invoiceDraft.dueDays = e.target.value;
          var idisp = document.getElementById('iDueDateDisplay');
          if(idisp) idisp.value = fullDate(addDays(todayIso(), Number(e.target.value)||0));
        }
        if(e.target.id==='iTerms'){ STATE.invoiceDraft.terms = e.target.value; }
      }
    };

    // drag & drop on board
    app.querySelectorAll('.card').forEach(function(card){
      card.addEventListener('dragstart', function(e){
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', card.getAttribute('data-id'));
        e.dataTransfer.effectAllowed = 'move';
      });
      card.addEventListener('dragend', function(){ card.classList.remove('dragging'); });
    });
    app.querySelectorAll('.col').forEach(function(col){
      col.addEventListener('dragover', function(e){ e.preventDefault(); col.classList.add('dragover'); });
      col.addEventListener('dragleave', function(){ col.classList.remove('dragover'); });
      col.addEventListener('drop', function(e){
        e.preventDefault(); col.classList.remove('dragover');
        var id = e.dataTransfer.getData('text/plain');
        var status = col.getAttribute('data-status');
        if(id && status==='invoiced' && isTechnician()){ toast('Only the office can move a job to Invoiced'); return; }
        if(id && status){ updateOrder(id, {status:status}); }
      });
    });
  }

  function focusEl(id){
    var el = document.getElementById(id);
    if(el){ el.focus(); var v=el.value; el.value=''; el.value=v; }
  }

  function copyText(text, okMessage){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){ toast(okMessage||'Link copied'); }).catch(function(){ toast('Could not copy — select and copy manually'); });
    } else {
      toast('Could not copy — select and copy manually');
    }
  }

  function saveOrderFromModal(id){
    var patch = {
      title: document.getElementById('ofTitle').value.trim() || 'Untitled job',
      status: document.getElementById('ofStatus').value,
      category: document.getElementById('ofCategory').value,
      description: document.getElementById('ofDesc').value,
      qty: Number(document.getElementById('ofQty').value)||1,
      dueDate: document.getElementById('ofDue').value,
      notes: document.getElementById('ofNotes').value
    };
    var odEl = document.getElementById('ofOrderDate');
    if(odEl && isOwnerRole() && odEl.value){ var curO = STATE.orders.find(function(x){ return x.id===id; }); if(!curO || odEl.value!==orderDateOf(curO) || !curO.orderDate) patch.orderDate = odEl.value; }
    var poEl = document.getElementById('ofPo');
    if(poEl && !isTechnician()) patch.poNumber = poEl.value.trim();
    if(!isTechnician() && document.getElementById('ofQuote')){
      patch.invoiceNumber = document.getElementById('ofInvNo').value.trim();
      patch.invoiced = document.getElementById('ofInvoiced').checked;
      var qv = document.getElementById('ofQuote').value;
      patch.quoteAmount = qv===''? null : Number(qv);
      if(patch.invoiced && AFTER_INVOICE.indexOf(patch.status)<0){ patch.status='invoiced'; }
    }
    var desId = document.getElementById('ofAsgDesigner').value;
    var techId = document.getElementById('ofAsgTechnician').value;
    var desMember = STATE.team.find(function(m){ return m.id===desId; });
    var techMember = STATE.team.find(function(m){ return m.id===techId; });
    patch.designerId = desId || null;
    patch.designerName = desMember ? desMember.name : '';
    var tech2El = document.getElementById('ofAsgTechnician2');
    var tech2Id = tech2El ? tech2El.value : '';
    if(tech2Id && tech2Id===techId) tech2Id = '';
    if(!techId && tech2Id){ techId = tech2Id; techMember = STATE.team.find(function(m){ return m.id===techId; }); tech2Id = ''; }
    var tech2Member = STATE.team.find(function(m){ return m.id===tech2Id; });
    patch.technicianId = techId || null;
    patch.technicianName = techMember ? techMember.name : '';
    patch.technician2Id = tech2Id || null;
    patch.technician2Name = tech2Member ? tech2Member.name : '';
    var cur = STATE.orders.find(function(x){ return x.id===id; });
    if(cur && cur.quoteOnly){ patch.status = 'quote'; delete patch.invoiced; }
    updateOrder(id, patch);
    STATE.openOrderId = null;
    render();
    toast('Job updated');
  }

  function submitNewOrder(){
    var name = document.getElementById('noCustomer').value.trim();
    if(!name){ toast('Add a customer name first'); return; }
    var phone = document.getElementById('noPhone').value.trim();
    var title = document.getElementById('noTitle').value.trim() || 'Untitled job';
    var quoteVal = document.getElementById('noQuote').value;
    var desEl = document.getElementById('noAsgDesigner'), techEl = document.getElementById('noAsgTechnician');
    var desMember = desEl ? STATE.team.find(function(m){ return m.id===desEl.value; }) : null;
    var techMember = techEl ? STATE.team.find(function(m){ return m.id===techEl.value; }) : null;
    var tech2El = document.getElementById('noAsgTechnician2');
    var tech2Member = tech2El ? STATE.team.find(function(m){ return m.id===tech2El.value; }) : null;
    if(tech2Member && techMember && tech2Member.id===techMember.id) tech2Member = null;
    if(!techMember && tech2Member){ techMember = tech2Member; tech2Member = null; }

    var existing = findCustomerByName(name);
    var customerPromise = existing ? Promise.resolve(existing) : persistCustomer({name:name, phone:phone, email:'', notes:''});

    customerPromise.then(function(cust){
      var order = {
        designerId: desMember ? desMember.id : null,
        designerName: desMember ? desMember.name : '',
        technicianId: techMember ? techMember.id : null,
        technicianName: techMember ? techMember.name : '',
        technician2Id: tech2Member ? tech2Member.id : null,
        technician2Name: tech2Member ? tech2Member.name : '',
        customerId: cust.id,
        customerName: cust.name,
        phone: phone || cust.phone || '',
        category: document.getElementById('noCategory').value,
        title: title,
        description: document.getElementById('noDesc').value,
        poNumber: ((document.getElementById('noPo')||{}).value||'').trim(),
        qty: Number(document.getElementById('noQty').value)||1,
        status: 'new',
        quoteAmount: quoteVal===''? null : Number(quoteVal),
        invoiced:false,
        invoiceNumber:'',
        dueDate: document.getElementById('noDue').value,
        orderDate: (isOwnerRole() && (document.getElementById('noOrderDate')||{}).value) || todayIso(),
        notes:'',
        source: document.getElementById('noSource').value,
        attachmentIds:[],
        createdAt: todayIso(),
        updatedAt: todayIso()
      };
      return reserveNumbers('nextJobNumber', 1).then(function(n){ order.jobNumber = 'DSX-J'+pad4(n); return persistOrder(order); });
    }).then(function(order){
      var pf = STATE.newOrderPrefill;
      if(pf && pf.messageId){ markWaHandled(pf.waPhone, pf.messageId, 'logged', order.id); }
      STATE.newOrderOpen = false;
      STATE.newOrderPrefill = null;
      render();
      toast('Job added to board');
    });
  }

  function submitNewTeamMember(){
    var name = document.getElementById('ntName').value.trim();
    if(!name){ toast('Add a name first'); return; }
    var role = document.getElementById('ntRole').value;
    var phone = document.getElementById('ntPhone').value.trim();
    persistTeamMember({name:name, role:role, phone:phone, email:'', invited:false, invitedAt:null, createdAt:todayIso()}).then(function(){
      STATE.newTeamOpen = false;
      render();
      toast(name+' added to the team');
    });
  }

  /* ============================ customer form (individual / business) ============================ */
  var MAX_EXTRA_CONTACTS = 5;
  function blankAddress(){ return {line1:'', line2:'', city:'', region:'', postalCode:'', country:'South Africa'}; }
  function blankPerson(){ return {firstName:'', lastName:'', email:'', phone:''}; }
  function addrHasData(a){ return !!(a && (a.line1||a.line2||a.city||a.region||a.postalCode)); }
  function formatAddress(a){
    if(!addrHasData(a)) return '';
    var cityLine = [a.city, a.region, a.postalCode].filter(Boolean).join(', ');
    return [a.line1, a.line2, cityLine, a.country].filter(Boolean).join('\n');
  }
  function customerDeliveryAddress(c){ return c.deliverySame===false ? (c.deliveryAddress||blankAddress()) : (c.postalAddress||blankAddress()); }
  function personName(p){ return [p && p.firstName, p && p.lastName].filter(Boolean).join(' '); }

  function openCustomerForm(id){
    var c = id ? STATE.customers.find(function(x){ return x.id===id; }) : null;
    var d = {
      type: (c && c.type) || 'individual',
      name: c ? (c.name||'') : '',
      firstName: (c && c.firstName) || '', lastName: (c && c.lastName) || '',
      email: (c && c.email) || '', phone: (c && c.phone) || '',
      notes: (c && c.notes) || '',
      website: (c && c.website) || '', regNumber: (c && c.regNumber) || '', vatNumber: (c && c.vatNumber) || '',
      postalAddress: Object.assign(blankAddress(), (c && c.postalAddress) || {}),
      deliverySame: c ? c.deliverySame!==false : true,
      deliveryAddress: Object.assign(blankAddress(), (c && c.deliveryAddress) || {}),
      contacts: ((c && c.contacts) || []).map(function(p){ return Object.assign(blankPerson(), p); })
    };
    STATE.customerForm = {id: c ? c.id : null, draft: d, errors: {}};
    render();
    setTimeout(function(){ var el = document.getElementById('cfName'); if(el && !id) el.focus(); }, 0);
  }
  function addCustomerPrompt(){ openCustomerForm(null); }

  function setDraftPath(path, value){
    var d = STATE.customerForm && STATE.customerForm.draft; if(!d) return;
    var parts = path.split('.'), o = d;
    for(var i=0;i<parts.length-1;i++){ o = o[parts[i]]; if(o==null) return; }
    o[parts[parts.length-1]] = value;
  }

  function customerNameTaken(name, exceptId){
    var n = String(name||'').trim().toLowerCase().replace(/\s+/g,' ');
    if(!n) return false;
    return STATE.customers.some(function(c){ return c.id!==exceptId && String(c.name||'').trim().toLowerCase().replace(/\s+/g,' ')===n; });
  }

  function validateCustomerDraft(){
    var f = STATE.customerForm, d = f.draft, e = {};
    var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if(!d.name.trim()) e.name = 'Contact name is required.';
    else if(customerNameTaken(d.name, f.id)) e.name = 'Another customer already has this name. Contact names must be unique.';
    if(d.email && !emailRe.test(d.email.trim())) e.email = 'This email address doesn’t look right.';
    if(d.type==='business'){
      d.contacts.forEach(function(p, i){ if(p.email && !emailRe.test(p.email.trim())) e['contact'+i] = 'Check this email address.'; });
      if(d.website && /\s/.test(d.website.trim())) e.website = 'A website can’t contain spaces.';
    }
    f.errors = e;
    return !Object.keys(e).length;
  }

  function cleanAddress(a){ var o = {}; Object.keys(blankAddress()).forEach(function(k){ o[k] = String((a&&a[k])||'').trim(); }); return o; }

  function saveCustomerForm(){
    var f = STATE.customerForm; if(!f) return;
    if(!validateCustomerDraft()){ render(); toast('Please fix the highlighted fields'); return; }
    var d = f.draft, biz = d.type==='business';
    var data = {
      type: d.type,
      name: d.name.trim().replace(/\s+/g,' '),
      firstName: d.firstName.trim(), lastName: d.lastName.trim(),
      email: d.email.trim(), phone: d.phone.trim(), notes: d.notes,
      postalAddress: cleanAddress(d.postalAddress),
      deliverySame: !!d.deliverySame,
      deliveryAddress: d.deliverySame ? cleanAddress(blankAddress()) : cleanAddress(d.deliveryAddress),
      website: biz ? d.website.trim() : '',
      regNumber: biz ? d.regNumber.trim() : '',
      vatNumber: biz ? d.vatNumber.trim() : '',
      contacts: biz ? d.contacts.map(function(p){ return {firstName:p.firstName.trim(), lastName:p.lastName.trim(), email:p.email.trim(), phone:p.phone.trim()}; })
                        .filter(function(p){ return p.firstName||p.lastName||p.email||p.phone; }).slice(0, MAX_EXTRA_CONTACTS) : [],
      updatedAt: todayIso()
    };
    var p = f.id ? updateCustomerRecord(f.id, data) : persistCustomer(Object.assign({createdAt: todayIso()}, data));
    var wasEdit = !!f.id;
    p.then(function(c){
      // keep the name shown on that customer's jobs in step with the record
      if(wasEdit){
        STATE.orders.filter(function(o){ return o.customerId===f.id && (o.customerName!==data.name || (data.phone && o.phone!==data.phone)); }).forEach(function(o){
          updateOrder(o.id, {customerName:data.name, phone:data.phone || o.phone});
        });
      }
      STATE.customerForm = null;
      if(c && c.id) STATE.viewCustomerId = c.id;
      render();
      toast(wasEdit ? 'Customer updated' : 'Customer added');
    }).catch(function(){ toast('Could not save the customer — try again'); });
  }

  function addressFields(prefix, key, a){
    function inp(field, label, ph, extra){
      return '<div class="field"><label for="'+prefix+field+'">'+label+'</label><input type="text" id="'+prefix+field+'" data-cf="'+key+'.'+field+'" value="'+escapeHtml(a[field]||'')+'"'+(ph?' placeholder="'+escapeHtml(ph)+'"':'')+(extra||'')+'></div>';
    }
    return inp('line1','Street address / PO Box','e.g. 36A Reitz Street') +
      inp('line2','Suburb / address line 2','e.g. Central') +
      '<div class="field-row3">' + inp('city','Town / city','Kroonstad') + inp('region','Province','Free State') + inp('postalCode','Postal code','9499',' inputmode="numeric"') + '</div>' +
      inp('country','Country','');
  }

  function renderCustomerForm(){
    var f = STATE.customerForm, d = f.draft, e = f.errors || {}, biz = d.type==='business';
    function fld(id, path, label, val, opts){
      opts = opts || {};
      var err = opts.err ? '<div class="field-error">'+escapeHtml(opts.err)+'</div>' : '';
      return '<div class="field"><label for="'+id+'">'+label+'</label><input type="'+(opts.type||'text')+'" id="'+id+'" data-cf="'+path+'" value="'+escapeHtml(val||'')+'"'+(opts.ph?' placeholder="'+escapeHtml(opts.ph)+'"':'')+(opts.err?' class="invalid"':'')+(opts.attrs||'')+'>'+(opts.hint?'<div class="hint">'+opts.hint+'</div>':'')+err+'</div>';
    }
    var contacts = '';
    if(biz){
      contacts = '<div class="form-section"><div class="section-label">Additional contact persons ('+d.contacts.length+' of '+MAX_EXTRA_CONTACTS+')</div>' +
        d.contacts.map(function(p, i){
          return '<div class="person-card"><div class="ph-head"><span>Contact '+(i+1)+'</span><button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;" data-action="cf-remove-contact" data-i="'+i+'">Remove</button></div>' +
            '<div class="field-row">' + fld('cfc'+i+'f','contacts.'+i+'.firstName','First name',p.firstName) + fld('cfc'+i+'l','contacts.'+i+'.lastName','Last name',p.lastName) + '</div>' +
            '<div class="field-row">' + fld('cfc'+i+'e','contacts.'+i+'.email','Email',p.email,{type:'email', err:e['contact'+i]}) + fld('cfc'+i+'p','contacts.'+i+'.phone','Cellphone',p.phone,{type:'tel'}) + '</div>' +
          '</div>';
        }).join('') +
        (d.contacts.length < MAX_EXTRA_CONTACTS ? '<button type="button" class="btn btn-sm" data-action="cf-add-contact">+ Add contact person</button>' : '<div class="hint">Maximum of '+MAX_EXTRA_CONTACTS+' additional contact persons.</div>') +
      '</div>';
    }
    return (
      '<div class="overlay">' +
        '<div class="modal" role="dialog" aria-modal="true" aria-label="'+(f.id?'Edit customer':'Add customer')+'" style="max-width:640px;">' +
          '<div class="modal-head"><h2>'+(f.id?'Edit customer':'Add customer')+'</h2><button class="modal-close" data-action="cf-cancel" aria-label="Close">&times;</button></div>' +
          '<div class="seg" role="radiogroup" aria-label="Customer type" style="margin-bottom:14px;">' +
            '<button type="button" role="radio" aria-checked="'+(!biz)+'" class="'+(!biz?'on':'')+'" data-action="cf-type" data-type="individual">Individual</button>' +
            '<button type="button" role="radio" aria-checked="'+biz+'" class="'+(biz?'on':'')+'" data-action="cf-type" data-type="business">Business</button>' +
          '</div>' +
          fld('cfName','name','Contact name *',d.name,{err:e.name, ph: biz ? 'e.g. Kroonstad Primary School' : 'e.g. Riaan Pretorius', hint:'Must be unique — this is the name used on quotes, invoices and in Xero.'}) +
          '<div class="section-label" style="margin:4px 0 8px;">Primary person</div>' +
          '<div class="field-row">' + fld('cfFirst','firstName','First name',d.firstName) + fld('cfLast','lastName','Last name',d.lastName) + '</div>' +
          '<div class="field-row">' + fld('cfEmail','email','Email address',d.email,{type:'email', err:e.email}) + fld('cfPhone','phone','Cellphone number',d.phone,{type:'tel', ph:'e.g. 082 123 4567'}) + '</div>' +
          (biz ?
            '<div class="form-section"><div class="section-label">Business details</div>' +
              fld('cfWeb','website','Website',d.website,{ph:'e.g. www.example.co.za', err:e.website}) +
              '<div class="field-row">' + fld('cfReg','regNumber','Business registration number',d.regNumber,{ph:'e.g. 2025/123456/07'}) + fld('cfVat','vatNumber','VAT number',d.vatNumber,{ph:'e.g. 4123456789'}) + '</div>' +
            '</div>' : '') +
          '<div class="form-section"><div class="section-label">Postal address</div>' + addressFields('cfPa','postalAddress', d.postalAddress) + '</div>' +
          '<div class="form-section"><div class="section-label">Delivery address</div>' +
            '<label style="display:flex; align-items:center; gap:8px; cursor:pointer; margin-bottom:10px; font-weight:500;"><input type="checkbox" id="cfDelSame" '+(d.deliverySame?'checked':'')+' style="width:auto;"> Same as postal address</label>' +
            (d.deliverySame ? '' : addressFields('cfDa','deliveryAddress', d.deliveryAddress)) +
          '</div>' +
          contacts +
          '<div class="form-section"><div class="field"><label for="cfNotes">Notes</label><textarea id="cfNotes" data-cf="notes" rows="3">'+escapeHtml(d.notes||'')+'</textarea></div></div>' +
          '<div class="modal-foot">' +
            '<button class="btn btn-ghost" data-action="cf-cancel">Cancel</button>' +
            '<button class="btn btn-primary" data-action="cf-save">'+(f.id?'Save changes':'Add customer')+'</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // Owner-only: load a backup JSON {config, customers, orders, team, wa_handled}.
  function importBackupFile(file){
    if(!file || !isOwnerRole() || !STATE.db) return;
    var reader = new FileReader();
    reader.onload = function(){
      var data;
      try{ data = JSON.parse(String(reader.result||'')); }catch(e){ toast('That file isn’t a valid backup (.json)'); return; }
      var writes = [];
      if(data.config && typeof data.config==='object'){ var cfg = Object.assign({}, data.config); delete cfg.appShareLink; writes.push({path:'config/business', data:cfg}); }
      ['customers','orders','team','wa_handled'].forEach(function(col){
        var rows = data[col] || {};
        Object.keys(rows).forEach(function(id){
          var d = Object.assign({}, rows[id]);
          delete d.id;
          if(col==='team'){
            // Invite codes from another system can't be reused: invite people again.
            delete d.inviteHash; delete d.inviteSalt; delete d.inviteIter; delete d.inviteExpires;
            d.invited = false; d.invitedAt = null; d.active = true;
          }
          writes.push({path: col+'/'+id, data:d});
        });
      });
      if(!writes.length){ toast('No records found in that file'); return; }
      if(!confirm('Import '+writes.length+' records into DsignX Ops? Records with the same ID will be overwritten.')) return;
      STATE.importStatus = 'Importing 0 of '+writes.length+'…'; render();
      window.DSX.importDocs(writes, function(done){ STATE.importStatus = 'Importing '+done+' of '+writes.length+'…'; render(); }).then(function(){
        STATE.importStatus = 'Imported '+writes.length+' records.'; render(); toast('Import complete');
      }).catch(function(e){
        STATE.importStatus = 'Import stopped: '+((e && e.message) || 'unknown error')+'. You can run it again safely.'; render();
      });
    };
    reader.readAsText(file);
  }

  function handleAttach(file){
    if(!file || !STATE.assets || !STATE.openOrderId) return;
    STATE.assets.upload(file).then(function(res){
      var o = STATE.orders.find(function(x){return x.id===STATE.openOrderId;});
      if(!o) return;
      var ids = (o.attachmentIds||[]).concat([res.id]);
      updateOrder(o.id, {attachmentIds: ids});
      toast('Attachment added');
    }).catch(function(err){
      var why = (err && err.code==='too_large') ? 'files must be under 9 MB' : waErrorNotice(err||{}).text;
      toast('Could not upload the file — ' + why);
    });
  }

  // Artwork/proofs: uploaded to Cloudinary and staged in the job chat (Bird sends it).
  // Without WhatsApp on this view it falls back to download-and-attach.
  function sendArtworkViaWhatsapp(orderId, attachmentId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!o) return;
    var phone = waPhone(o.phone);
    if(!phone){ toast('No phone number on file to message'); return; }
    if(/^https:\/\//.test(attachmentId) && STATE.mcp){
      // Attachments already live on Cloudinary, so WhatsApp can fetch them directly.
      var isPdf = /\.pdf(\?|$)/i.test(attachmentId);
      var entry = Object.assign({}, STATE.chatMessages[phone]);
      entry.sendError = null;
      entry.pendingSend = {kind: isPdf ? 'file' : 'image', url: attachmentId,
        filename: 'artwork-'+jobNo(o.id)+(isPdf ? '.pdf' : '.jpg'),
        caption: 'Hi '+(o.customerName||'there')+', here\'s the artwork/proof for '+(o.title||'your job')+' ('+jobNo(o.id)+') — let us know if it looks right!'};
      STATE.chatMessages[phone] = entry;
      if(!entry.list) openOrderChat(phone);
      render();
      return;
    }
    fetch(attachmentId).then(function(r){
      if(!r.ok) throw new Error('fetch failed');
      return r.blob();
    }).then(function(blob){
      var ext = (blob.type && blob.type.indexOf('/')>-1) ? blob.type.split('/')[1].replace('+xml','') : 'png';
      var filename = 'artwork-'+jobNo(o.id)+'.'+ext;
      var caption = 'Hi '+(o.customerName||'there')+', here\'s the artwork/proof for '+(o.title||'your job')+' ('+jobNo(o.id)+') — let us know if it looks right!';
      if(STATE.mcp){
        attachFileToChat(phone, blob, filename, blob.type, caption);
        return;
      }
      // No WhatsApp tool connected on this view: fall back to a plain download so it
      // can still be attached by hand.
      if(STATE.downloads){
        STATE.downloads.save({filename:filename, data:blob}).catch(function(err){
          if(err && err.code==='declined'){ return; }
          fallbackDownload(blob, filename);
        });
      } else {
        fallbackDownload(blob, filename);
      }
      STATE.chatDraft[phone] = caption.replace('let us know', 'I\'m attaching it now — let us know');
      toast('Artwork downloading — attach it below and hit Send');
      render();
    }).catch(function(){ toast('Could not prepare that file — try again'); });
  }

  // Read-only check: which of the two connectors this view can reach.
  function checkWaMediaSupport(){
    if(!STATE.mcp) return;
    STATE.waMediaCheck = {status:'loading'};
    render();
    STATE.mcp.listTools().then(function(res){
      var servers = (res && res.servers) || [];
      var rows = [WA_SERVER, FILE_SERVER].map(function(n){
        var srv = servers.filter(function(x){ return x.server===n; })[0];
        return {name: n===WA_SERVER ? 'Bird (WhatsApp)' : 'Cloudinary (file links)', ok: !!(srv && srv.tools && srv.tools.length && srv.authStatus!=='needs_reauth')};
      });
      STATE.waMediaCheck = {status:'done', rows:rows};
      render();
    }).catch(function(err){
      STATE.waMediaCheck = {status:'error', error:err};
      render();
    });
  }

  /* ============================ numbering ============================ */
  // Reserves `count` consecutive numbers from config/business[field] and resolves the first one.
  // Live: a Firestore transaction, so two people can never get the same number.
  function reserveNumbers(field, count){
    count = count || 1;
    if(STATE.isLive && window.DSX && window.DSX.reserveNumbers){
      return window.DSX.reserveNumbers(field, count).then(function(start){
        var c = {}; c[field] = start + count;
        STATE.config = Object.assign({}, STATE.config, c);
        return start;
      });
    }
    var start = Number(STATE.config[field]) || 1;
    var patch = {}; patch[field] = start + count;
    STATE.config = Object.assign({}, STATE.config, patch);
    return Promise.resolve(start);
  }
  function pad4(n){ return String(n).padStart(4,'0'); }

  // Older jobs created before job numbers existed get one, in the order they were created.
  var _jobBackfillDone = false;
  function backfillJobNumbers(){
    if(_jobBackfillDone || !STATE.isLive || !isOwnerRole()) return;
    var missing = STATE.orders.filter(function(o){ return !o.jobNumber && !o.quoteOnly; });
    _jobBackfillDone = true;
    if(!missing.length) return;
    missing.sort(function(a,b){ return String(a.createdAt||'').localeCompare(String(b.createdAt||'')) || String(a.id).localeCompare(String(b.id)); });
    reserveNumbers('nextJobNumber', missing.length).then(function(start){
      return updateDocs(missing.map(function(o, i){ return {path:'orders/'+o.id, data:{jobNumber:'DSX-J'+pad4(start+i)}}; }));
    }).catch(function(){ _jobBackfillDone = false; });
  }
  function stripId(o){ var c = Object.assign({}, o); delete c.id; return c; }
  // Patches several existing documents in one go (only the given fields change).
  function updateDocs(list){
    if(!list.length) return Promise.resolve();
    if(STATE.isLive && window.DSX && window.DSX.updateDocs) return window.DSX.updateDocs(list);
    list.forEach(function(w){
      var parts = w.path.split('/'), coll = parts[0], id = parts[1];
      var arr = coll==='orders' ? STATE.orders : coll==='receipts' ? STATE.receipts : null;
      var rec = arr && arr.find(function(x){ return x.id===id; });
      if(rec) Object.assign(rec, w.data);
    });
    render();
    return Promise.resolve();
  }

  /* ============================ products (catalogue) ============================ */
  function productLabel(p){ return (p.code ? p.code+' · ' : '') + p.description + ' — ' + money(p.price) + (p.unit ? ' / '+p.unit : ''); }
  function productDatalist(){
    return '<datalist id="productOptions">' + STATE.products.filter(function(p){ return p.active!==false; }).map(function(p){
      return '<option value="'+escapeHtml(p.description)+'" label="'+escapeHtml((p.code?p.code+' · ':'')+money(p.price)+(p.unit?' / '+p.unit:''))+'">';
    }).join('') + '</datalist>';
  }
  function findProductByDescription(desc){
    var d = String(desc||'').trim().toLowerCase();
    if(!d) return null;
    return STATE.products.find(function(p){ return String(p.description||'').trim().toLowerCase()===d; }) || null;
  }
  // When a line's description matches a catalogue product, fill in its price.
  function applyProductToLine(prefix, i, items){
    var li = items[i]; if(!li) return false;
    var p = findProductByDescription(li.description);
    if(!p) return false;
    li.unitPrice = Number(p.price)||0;
    if(!Number(li.qty)) li.qty = 1;
    var priceEl = document.getElementById(prefix+'Price-'+i); if(priceEl) priceEl.value = li.unitPrice;
    var qtyEl = document.getElementById(prefix+'Qty-'+i); if(qtyEl) qtyEl.value = li.qty;
    return true;
  }

  function productDocId(p){
    var base = String(p.code || p.description || 'item').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'item';
    return 'p-' + base;
  }

  function saveProduct(){
    var f = STATE.productForm; if(!f) return;
    var desc = String(f.description||'').trim();
    if(!desc){ f.error = 'Add a description.'; render(); return; }
    var price = Number(String(f.price).replace(/[^0-9.\-]/g,''));
    if(!(price>=0)){ f.error = 'Enter a valid price.'; render(); return; }
    var data = {code:String(f.code||'').trim(), description:desc, unit:String(f.unit||'').trim(), price:Math.round(price*100)/100, active:true, updatedAt:new Date().toISOString()};
    var prev = f.id ? (STATE.products.find(function(x){ return x.id===f.id; }) || {}) : {};
    var sel = document.getElementById('pfStockItem');
    data.stockItem = sel ? !!sel.checked : !!prev.stockItem;
    var qv = String(f.stockQty==null?'':f.stockQty).trim();
    if(isOwnerRole() && qv!==''){ var qn = Number(qv.replace(',', '.')); if(!(qn>=0)){ f.error = 'Enter a valid quantity.'; render(); return; } data.stockQty = qn; }
    else if(prev.stockQty!=null) data.stockQty = prev.stockQty;
    if(prev.stockTakenAt) data.stockTakenAt = prev.stockTakenAt;
    var id = f.id || productDocId(data);
    if(!f.id && STATE.products.some(function(p){ return p.id===id; })){ id = id + '-' + Math.random().toString(36).slice(2,6); }
    var done = function(){ STATE.productForm = null; render(); toast('Product saved'); };
    if(STATE.isLive && STATE.db){ STATE.db.doc('products/'+id).set(data).then(done).catch(function(){ toast('Could not save — try again'); }); }
    else { var ix = STATE.products.findIndex(function(p){ return p.id===id; }); if(ix>=0) STATE.products[ix] = Object.assign({id:id}, data); else STATE.products.push(Object.assign({id:id}, data)); done(); }
  }
  function deleteProduct(id){
    if(!confirm('Remove this product from the catalogue? Existing quotes and invoices are not affected.')) return;
    if(STATE.isLive && STATE.db){ STATE.db.doc('products/'+id).delete().catch(function(){ toast('Could not remove — try again'); }); }
    else { STATE.products = STATE.products.filter(function(p){ return p.id!==id; }); render(); }
  }

  // Spreadsheet import: CSV in the browser, Excel via SheetJS (loaded only when needed).
  var XLSX_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
  function loadXlsx(){
    if(window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise(function(resolve, reject){
      var s = document.createElement('script'); s.src = XLSX_URL;
      s.onload = function(){ window.XLSX ? resolve(window.XLSX) : reject(new Error('Spreadsheet reader did not load')); };
      s.onerror = function(){ reject(new Error('Could not load the spreadsheet reader — check your internet connection')); };
      document.head.appendChild(s);
    });
  }
  function parseCsv(text){
    var rows = [], row = [], cell = '', q = false;
    for(var i=0;i<text.length;i++){
      var ch = text[i];
      if(q){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q = false; } else cell += ch; }
      else if(ch==='"') q = true;
      else if(ch===',' || ch===';' || ch==='\t'){ row.push(cell); cell=''; }
      else if(ch==='\n'){ row.push(cell); rows.push(row); row=[]; cell=''; }
      else if(ch!=='\r') cell += ch;
    }
    if(cell!=='' || row.length){ row.push(cell); rows.push(row); }
    return rows;
  }
  var HEADER_MAP = {
    code: ['code','sku','item code','product code','itemcode','stock code','ref','reference'],
    description: ['description','name','item','product','product name','item name','item description','details'],
    unit: ['unit','uom','unit of measure','units','per'],
    price: ['price','unit price','selling price','sales price','price excl','price excl vat','price (excl vat)','price ex vat','rate','amount','unitamount','unit amount']
  };
  function mapRows(rows){
    // find the header row: the first row that names a description and a price column
    var hi = -1, cols = {};
    for(var r=0; r<Math.min(rows.length, 15); r++){
      var c = {};
      rows[r].forEach(function(h, idx){
        var k = String(h||'').trim().toLowerCase().replace(/\*/g,'');
        Object.keys(HEADER_MAP).forEach(function(f){ if(c[f]===undefined && HEADER_MAP[f].indexOf(k)>=0) c[f] = idx; });
      });
      if(c.description!==undefined && c.price!==undefined){ hi = r; cols = c; break; }
    }
    if(hi<0) return {error:'Couldn’t find the column headings. The sheet needs at least a “Description” and a “Price” column (Code and Unit are optional).'};
    var items = [], skipped = 0;
    rows.slice(hi+1).forEach(function(row){
      var desc = String(row[cols.description]||'').trim();
      if(!desc){ return; }
      var price = parseMoney(row[cols.price]);
      var raw = price==null ? '' : String(price);
      if(raw==='' || isNaN(price)){ skipped++; return; }
      items.push({code: cols.code!==undefined ? String(row[cols.code]||'').trim() : '', description:desc, unit: cols.unit!==undefined ? String(row[cols.unit]||'').trim() : '', price:Math.round(price*100)/100});
    });
    return {items:items, skipped:skipped};
  }
  // Accepts 350, "350.00", "R 1 250,50", "R1,250.50" — South African and international formats.
  function parseMoney(v){
    if(typeof v==='number') return isFinite(v) ? v : null;
    var s = String(v==null?'':v).replace(/[R\s\u00a0]/gi,'');
    if(!s) return null;
    if(s.indexOf(',')>=0 && s.indexOf('.')>=0) s = s.replace(/,/g,'');
    else if(s.indexOf(',')>=0) s = (/,\d{1,2}$/.test(s) ? s.replace(/\.(?=\d{3})/g,'').replace(',', '.') : s.replace(/,/g,''));
    var n = Number(s);
    return isNaN(n) ? null : n;
  }
  function importProductsFile(file){
    if(!file) return;
    STATE.productImport = {status:'reading', name:file.name};
    render();
    var isCsv = /\.csv$/i.test(file.name) || file.type==='text/csv';
    var p = isCsv
      ? file.text().then(function(t){ return parseCsv(t.replace(/^﻿/,'')); })
      : loadXlsx().then(function(X){
          return file.arrayBuffer().then(function(buf){
            var wb = X.read(buf, {type:'array'});
            return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true, defval:''});
          });
        });
    p.then(function(rows){
      var res = mapRows(rows);
      if(res.error){ STATE.productImport = {status:'error', name:file.name, error:res.error}; render(); return; }
      if(!res.items.length){ STATE.productImport = {status:'error', name:file.name, error:'No products with a price were found in that file.'}; render(); return; }
      STATE.productImport = {status:'preview', name:file.name, items:res.items, skipped:res.skipped};
      render();
    }).catch(function(e){ STATE.productImport = {status:'error', name:file.name, error:(e && e.message) || 'Could not read that file.'}; render(); });
  }
  function confirmProductImport(){
    var imp = STATE.productImport; if(!imp || !imp.items) return;
    var byCode = {}, byDesc = {};
    STATE.products.forEach(function(p){ if(p.code) byCode[p.code.toLowerCase()] = p.id; byDesc[String(p.description).toLowerCase()] = p.id; });
    var now = new Date().toISOString(), used = {};
    var writes = imp.items.map(function(it){
      var id = (it.code && byCode[it.code.toLowerCase()]) || byDesc[it.description.toLowerCase()] || productDocId(it);
      while(used[id]) id = id + '-2';
      used[id] = true;
      var old = STATE.products.find(function(p){ return p.id===id; }) || {};
      var keep = {}; ['stockQty','stockItem','stockTakenAt'].forEach(function(k){ if(old[k]!==undefined) keep[k] = old[k]; });
      return {path:'products/'+id, data:Object.assign({}, it, keep, {active:true, updatedAt:now})};
    });
    STATE.productImport = {status:'saving', name:imp.name, total:writes.length};
    render();
    var finish = function(){ STATE.productImport = {status:'done', name:imp.name, total:writes.length}; render(); toast(writes.length+' products imported'); };
    if(STATE.isLive && window.DSX){ window.DSX.importDocs(writes).then(finish).catch(function(e){ STATE.productImport = {status:'error', name:imp.name, error:'Import stopped: '+((e&&e.message)||'unknown error')}; render(); }); }
    else { writes.forEach(function(w){ var id = w.path.split('/')[1]; var ix = STATE.products.findIndex(function(p){ return p.id===id; }); var rec = Object.assign({id:id}, w.data); if(ix>=0) STATE.products[ix] = rec; else STATE.products.push(rec); }); finish(); }
  }
  function downloadProductTemplate(){
    var csv = 'Code,Description,Unit,Price (excl VAT)\r\nVIN-001,Vinyl lettering per m²,m²,350.00\r\nBAN-A1,A1 PVC banner with eyelets,each,280.00\r\nMUG-11,11oz sublimation mug,each,85.00\r\n';
    var blob = new Blob([csv], {type:'text/csv'});
    if(STATE.downloads){ STATE.downloads.save({filename:'DsignX-product-catalogue-template.csv', data:blob}).catch(function(){ fallbackDownload(blob, 'DsignX-product-catalogue-template.csv'); }); }
    else fallbackDownload(blob, 'DsignX-product-catalogue-template.csv');
  }

  function renderProductsTab(){
    var q = (STATE.productQuery||'').trim().toLowerCase();
    var list = STATE.products.slice().sort(function(a,b){ return String(a.description).localeCompare(String(b.description)); });
    if(q) list = list.filter(function(p){ return (p.code+' '+p.description+' '+p.unit).toLowerCase().indexOf(q)>=0; });
    var imp = STATE.productImport;
    var impHtml = '';
    if(imp){
      if(imp.status==='reading') impHtml = '<div class="hint">Reading '+escapeHtml(imp.name)+'…</div>';
      else if(imp.status==='error') impHtml = '<div class="hint" style="color:var(--critical);">'+escapeHtml(imp.error)+'</div>';
      else if(imp.status==='saving') impHtml = '<div class="hint">Importing '+imp.total+' products…</div>';
      else if(imp.status==='done') impHtml = '<div class="hint"><strong>Imported '+imp.total+' products from '+escapeHtml(imp.name)+'.</strong></div>';
      else if(imp.status==='preview'){
        impHtml = '<div class="hint" style="margin-bottom:8px;">Found <strong>'+imp.items.length+'</strong> products in '+escapeHtml(imp.name)+(imp.skipped?(' ('+imp.skipped+' rows skipped — no price)'):'')+'. Products with the same code (or description) are updated; others are added.</div>' +
          '<div class="tbl-wrap" style="max-height:220px; overflow:auto; margin-bottom:10px;"><table><thead><tr><th>Code</th><th>Description</th><th>Unit</th><th>Price excl VAT</th></tr></thead><tbody>' +
          imp.items.slice(0,50).map(function(it){ return '<tr><td class="mono">'+escapeHtml(it.code)+'</td><td>'+escapeHtml(it.description)+'</td><td>'+escapeHtml(it.unit)+'</td><td class="num">'+money(it.price)+'</td></tr>'; }).join('') +
          (imp.items.length>50 ? '<tr><td colspan="4" class="empty-note">…and '+(imp.items.length-50)+' more</td></tr>' : '') +
          '</tbody></table></div>' +
          '<button class="btn btn-primary btn-sm" data-action="product-import-confirm">Import '+imp.items.length+' products</button> <button class="btn btn-ghost btn-sm" data-action="product-import-cancel">Cancel</button>';
      }
    }
    var f = STATE.productForm;
    var formHtml = f ? (
      '<div class="panel">' +
        '<div class="section-label">'+(f.id?'Edit product':'Add product')+'</div>' +
        (f.error ? '<div class="field-error" style="margin-bottom:8px;">'+escapeHtml(f.error)+'</div>' : '') +
        '<div class="field-row">' +
          '<div class="field"><label for="pfCode">Code (optional)</label><input type="text" id="pfCode" data-pf="code" value="'+escapeHtml(f.code||'')+'"></div>' +
          '<div class="field"><label for="pfUnit">Unit (optional)</label><input type="text" id="pfUnit" data-pf="unit" placeholder="each, m², per hour" value="'+escapeHtml(f.unit||'')+'"></div>' +
        '</div>' +
        '<div class="field"><label for="pfDesc">Description</label><input type="text" id="pfDesc" data-pf="description" value="'+escapeHtml(f.description||'')+'"></div>' +
        '<div class="field-row">' +
          '<div class="field"><label for="pfPrice">Price excl VAT ('+escapeHtml(STATE.config.currency||'ZAR')+')</label><input type="number" step="0.01" min="0" id="pfPrice" data-pf="price" value="'+escapeHtml(f.price==null?'':String(f.price))+'"></div>' +
          '<div class="field"><label for="pfQty">Quantity in stock</label><input type="number" step="any" min="0" id="pfQty" data-pf="stockQty" value="'+escapeHtml(f.stockQty==null?'':String(f.stockQty))+'"'+(isOwnerRole()?'':' disabled')+'><div class="hint">'+(isOwnerRole()?'Opening balance. After that, stock takes update it.':'Only the owner can change quantities.')+'</div></div>' +
        '</div>' +
        '<label class="perm-toggle" style="display:flex; gap:6px; align-items:center; margin:2px 0 12px;"><input type="checkbox" id="pfStockItem" '+(f.stockItem?'checked':'')+'> Count this product in stock takes</label>' +
        '<button class="btn btn-primary btn-sm" data-action="product-save">Save product</button> <button class="btn btn-ghost btn-sm" data-action="product-cancel">Cancel</button>' +
      '</div>') : '';
    var rows = list.length ? list.map(function(p){
      return '<tr><td style="text-align:center;"><input type="checkbox" class="stock-tick" data-action="product-stock-toggle" data-id="'+p.id+'" '+(p.stockItem?'checked':'')+' aria-label="Count '+escapeHtml(p.description)+' in stock takes"></td><td class="mono">'+escapeHtml(p.code||'')+'</td><td>'+escapeHtml(p.description)+'</td><td>'+escapeHtml(p.unit||'')+'</td><td class="num">'+money(p.price)+'</td><td class="num">'+(p.stockItem || p.stockQty!=null ? (stockQtyOf(p)<0 ? '<span style="color:var(--critical); font-weight:700;" title="More invoiced than in stock — check at the next stock take">'+fmtQty(stockQtyOf(p))+'</span>' : fmtQty(stockQtyOf(p))) : '<span style="color:var(--ink-faint);">—</span>')+'</td>' +
        '<td style="white-space:nowrap;"><button class="btn btn-ghost btn-sm" data-action="product-edit" data-id="'+p.id+'">Edit</button><button class="btn btn-ghost btn-sm" data-action="product-delete" data-id="'+p.id+'">Remove</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty-note">'+(STATE.products.length?'No products match your search.':'No products yet — upload your price list or add products one by one.')+'</td></tr>';
    return (
      '<div class="topline"><div><h1>Products</h1><div class="sub">Your price list. Pick products while writing quotes and invoices.</div></div>' +
        '<button class="btn btn-primary" data-action="product-new">+ Add product</button></div>' +
      formHtml +
      '<div class="panel">' +
        '<div class="section-label">Upload a price list</div>' +
        '<p class="hint" style="margin-top:0;">Excel (.xlsx) or CSV with the columns <strong>Code</strong>, <strong>Description</strong>, <strong>Unit</strong> and <strong>Price</strong> (excl VAT). Only Description and Price are required. <a href="#" data-action="product-template">Download an example file</a>.</p>' +
        '<label class="btn btn-sm" style="cursor:pointer;">Choose file…<input type="file" id="productFile" accept=".xlsx,.xls,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style="display:none"></label>' +
        '<div style="margin-top:10px;">'+impHtml+'</div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="search" style="margin-bottom:10px;"><input type="text" id="productSearch" placeholder="Search products…" value="'+escapeHtml(STATE.productQuery||'')+'"></div>' +
        '<div class="tbl-wrap"><table><thead><tr><th title="Tick to include in stock takes" style="text-align:center;">Count</th><th>Code</th><th>Description</th><th>Unit</th><th>Price excl VAT</th><th class="num">In stock</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
        '<div class="hint" style="margin-top:8px;">'+STATE.products.length+' products in the catalogue &middot; '+STATE.products.filter(function(p){ return p.stockItem; }).length+' ticked for stock takes &middot; <a href="#" data-action="stock-tick-all">Tick all</a> &middot; <a href="#" data-action="stock-untick-all">Untick all</a></div>' +
      '</div>' +
      renderStocktakePanel()
    );
  }

  /* ============================ receipts ============================ */
  function orderReceipts(orderId){
    return STATE.receipts.filter(function(r){ return r.orderId===orderId && !r.voided; })
      .sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); });
  }
  function orderPaid(orderId){ return orderReceipts(orderId).reduce(function(s,r){ return s + (Number(r.amount)||0); }, 0); }
  function hasInvoiceDoc(o){ return !!(o.invoiceNumber && o.invoiceGeneratedAt && (o.invoiceLineItems||[]).length); }
  // What the customer owes for the job: the invoice total once invoiced, otherwise the quote.
  function orderAmountDue(o){
    if(hasInvoiceDoc(o)) return invoiceTotals({items:o.invoiceLineItems, vatEnabled:!!o.invoiceVatEnabled && isVatVendor()}).total - orderCredited(o.id);
    if((o.lineItems||[]).length) return quoteTotals({items:o.lineItems, vatEnabled:!!o.quoteVatEnabled && isVatVendor()}).total;
    return Number(o.quoteAmount)||0;
  }
  function round2(n){ return Math.round((Number(n)||0)*100)/100; }
  function payStatus(o){
    var due = round2(orderAmountDue(o)), paid = round2(orderPaid(o.id));
    var credited = hasInvoiceDoc(o) ? orderCredited(o.id) : 0;
    if(credited && due <= 0.004 && paid <= 0.004) return {key:'paid', label:'Credited', due:due, paid:0, balance:0, credited:credited};
    if(!paid) return {key:'unpaid', label:'Unpaid', due:due, paid:0, balance:due, credited:credited};
    if(due && paid >= due) return {key:'paid', label: paid>due ? 'Overpaid' : 'Paid', due:due, paid:paid, balance:round2(due-paid), credited:credited};
    if(!due && credited) return {key:'paid', label:'Paid', due:due, paid:paid, balance:round2(due-paid), credited:credited};
    return {key:'part', label: hasInvoiceDoc(o) ? 'Part-paid' : 'Deposit paid', due:due, paid:paid, balance:round2(due-paid), credited:credited};
  }

  function openReceiptForm(orderId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; }); if(!o) return;
    var st = payStatus(o);
    STATE.receiptForm = {orderId:orderId, amount: st.balance>0 ? st.balance.toFixed(2) : '', method:'cash', date:todayIso(), note:'', error:'', saved:null};
    render();
  }
  function saveReceipt(){
    var f = STATE.receiptForm; if(!f || f.busy) return;
    var o = STATE.orders.find(function(x){ return x.id===f.orderId; }); if(!o) return;
    var amount = round2(String(f.amount).replace(/[^0-9.\-]/g,''));
    if(!(amount>0)){ f.error = 'Enter the amount received.'; render(); return; }
    if(f.method!=='cash' && f.method!=='card'){ f.error = 'Choose cash or card.'; render(); return; }
    if(!f.date){ f.error = 'Choose the date.'; render(); return; }
    if(STATE.cashups[f.date]){ f.error = 'The cash-up for '+fullDate(f.date)+' is already done. Use today’s date, or ask the owner to reopen that cash-up.'; render(); return; }
    f.busy = true; f.error = ''; render();
    var member = currentTeamMember();
    reserveNumbers('nextReceiptNumber', 1).then(function(n){
      var rec = {
        number:'DSX-R'+pad4(n), date:f.date, createdAt:new Date().toISOString(), amount:amount, method:f.method,
        orderId:o.id, jobNumber:o.jobNumber||jobNo(o.id), jobTitle:o.title||'', invoiceNumber: hasInvoiceDoc(o) ? o.invoiceNumber : '',
        kind: hasInvoiceDoc(o) ? 'payment' : 'prepayment', customerId:o.customerId||null, customerName:o.customerName||'', phone:o.phone||'',
        note:String(f.note||'').trim(), receivedBy: member ? member.name : 'Owner', receivedById: member ? member.id : 'owner', voided:false, cashupDate:null
      };
      if(STATE.isLive && STATE.db){
        return STATE.db.collection('receipts').add(rec).then(function(ref){ return Object.assign({id:ref.id}, rec); });
      }
      var r = Object.assign({id:uid()}, rec); STATE.receipts.push(r); return r;
    }).then(function(r){
      f.busy = false; f.saved = r;
      // fully paid after an invoice → move the job to Invoiced if it isn't already
      render();
      toast('Receipt '+r.number+' saved');
    }).catch(function(){ f.busy = false; f.error = 'Couldn’t save — check your connection and try again.'; render(); });
  }
  function voidReceipt(id){
    var r = STATE.receipts.find(function(x){ return x.id===id; }); if(!r || !isOwnerRole()) return;
    if(r.cashupDate){ toast('This receipt is in a completed cash-up — reopen that cash-up first'); return; }
    var why = prompt('Void receipt '+r.number+'? Type a reason (it stays on record, marked VOID):');
    if(why===null) return;
    var patch = {voided:true, voidReason:String(why||'').trim() || 'Voided', voidedAt:new Date().toISOString()};
    if(STATE.isLive && STATE.db){ STATE.db.doc('receipts/'+id).update(patch).catch(function(){ toast('Could not void — try again'); }); }
    else { Object.assign(r, patch); render(); }
  }

  function receiptPdf(r){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return null; }
    var cfg = STATE.config;
    var o = STATE.orders.find(function(x){ return x.id===r.orderId; }) || {};
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195, W = R-L;
    var MAROON = [78,9,40], INK = [43,43,43], GREY = [95,99,88], SAGE = [121,128,110], PANEL = [244,245,242], RULE = [222,222,216];
    function color(c){ doc.setTextColor(c[0],c[1],c[2]); }
    function font(style, size){ doc.setFont('helvetica', style); doc.setFontSize(size); }
    var vatNo = String(cfg.businessVatNumber||'').trim();
    var logoW = 56, logoH = logoW*(358/800);
    doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 12, logoW, logoH);
    font('bold', 11.5); color(MAROON); doc.text(lh('docCompanyName'), R, 18.5, {align:'right'});
    font('normal', 8.3); color(GREY);
    doc.text(lh('docAddress'), R, 23, {align:'right'});
    doc.text('Tel '+lh('docTel')+'   |   WhatsApp '+lh('docWhatsapp'), R, 27.2, {align:'right'});
    doc.text(lh('docEmail')+'   |   '+lh('docWebsite'), R, 31.4, {align:'right'});
    doc.text('Reg No '+lh('docRegNo')+(vatNo?('   |   VAT No '+vatNo):''), R, 35.6, {align:'right'});
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 40.5, W, 0.9, 'F');

    font('bold', 25); color(MAROON); doc.text(r.voided ? 'RECEIPT — VOID' : 'RECEIPT', L, 55);
    font('bold', 7.2); color(SAGE); doc.text('RECEIVED FROM', L, 62);
    font('bold', 10.5); color(INK); doc.text(r.customerName||'Customer', L, 67.5);
    font('normal', 8.8); color(GREY); if(r.phone) doc.text(String(r.phone), L, 72);

    var bx = 115.5, by = 46;
    var info = [['Receipt Number', r.number, true], ['Date', fullDate(r.date)], ['Payment Method', r.method==='card'?'Card':'Cash'], ['Job Number', r.jobNumber||'']];
    if(r.invoiceNumber) info.push(['Invoice Number', r.invoiceNumber]);
    var boxH = 8 + info.length*4.7;
    doc.setFillColor(PANEL[0],PANEL[1],PANEL[2]); doc.rect(bx, by, R-bx, boxH, 'F');
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(bx, by, R-bx, 0.7, 'F');
    var iy = by+6.2;
    info.forEach(function(row){ font('bold', 8.3); color([140,140,132]); doc.text(row[0], bx+3, iy); font(row[2]?'bold':'normal', 8.6); color(INK); doc.text(String(row[1]), R-3, iy, {align:'right'}); iy += 4.7; });

    var y = Math.max(80, by+boxH+10);
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, W, 9, 'F');
    font('bold', 7.6); doc.setTextColor(255,255,255); doc.text('DESCRIPTION', L+2, y+5.8); doc.text('AMOUNT '+(cfg.currency||'ZAR'), R-2, y+5.8, {align:'right'});
    y += 15;
    var desc = r.kind==='prepayment'
      ? ('Pre-payment / deposit for job '+(r.jobNumber||'')+(r.jobTitle?(' — '+r.jobTitle):''))
      : ('Payment received on invoice '+(r.invoiceNumber||'')+(r.jobTitle?(' — '+r.jobTitle):''));
    font('normal', 9); color(INK);
    var dl = doc.splitTextToSize(desc, 130); doc.text(dl, L+2, y); doc.text(pdfNum(r.amount), R-2, y, {align:'right'});
    y += dl.length*4.2 + 2;
    if(r.note){ font('normal', 8.4); color(GREY); var nl = doc.splitTextToSize(r.note, 130); doc.text(nl, L+2, y); y += nl.length*3.9; }
    doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.2); doc.line(L, y+1, R, y+1);
    y += 9;

    var lx = 158, vx = R-1.5;
    var due = round2(orderAmountDue(o));
    var paidToDate = STATE.receipts.filter(function(x){ return x.orderId===r.orderId && !x.voided && String(x.createdAt) <= String(r.createdAt); }).reduce(function(s,x){ return s+(Number(x.amount)||0); }, 0);
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(108.5, y, R-108.5, 11, 'F');
    font('bold', 11); doc.setTextColor(255,255,255); doc.text('AMOUNT RECEIVED', lx, y+7, {align:'right'}); doc.text(pdfNum(r.amount), vx, y+7, {align:'right'});
    y += 18;
    font('normal', 8.8);
    if(due){
      color(GREY); doc.text(r.kind==='prepayment' ? 'Quoted amount' : 'Invoice total', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(due), vx, y, {align:'right'}); y += 5.5;
      color(GREY); doc.text('Total paid to date', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(paidToDate), vx, y, {align:'right'}); y += 5.5;
      font('bold', 9.5); color(MAROON); doc.text('Balance outstanding', lx, y, {align:'right'}); doc.text(pdfNum(Math.max(0, due - paidToDate)), vx, y, {align:'right'}); y += 8;
    }
    font('normal', 8.4); color(GREY); doc.text('Received by '+(r.receivedBy||'')+'.', L, y+6);

    doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.25); doc.line(L, 277, R, 277);
    font('bold', 8.5); color(MAROON); doc.text('Thank you for your business!', 105, 281.5, {align:'center'});
    font('normal', 6.8); color(GREY);
    doc.text([lh('docCompanyName'), 'Reg No '+lh('docRegNo')].concat(vatNo?['VAT No '+vatNo]:[]).concat([lh('docAddress')]).join('  ·  '), 105, 285, {align:'center'});
    return {blob:doc.output('blob'), filename:r.number+'.pdf'};
  }
  function downloadReceipt(id){
    var r = STATE.receipts.find(function(x){ return x.id===id; }); if(!r) return;
    var built = receiptPdf(r); if(!built) return;
    if(STATE.downloads){ STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){ if(!err||err.code!=='declined') fallbackDownload(built.blob, built.filename); }); }
    else fallbackDownload(built.blob, built.filename);
  }
  function sendReceiptWhatsapp(id){
    var r = STATE.receipts.find(function(x){ return x.id===id; }); if(!r) return;
    var phone = waPhone(r.phone); if(!phone){ toast('No phone number on file for this customer'); return; }
    if(!STATE.mcp){ toast('WhatsApp isn’t set up — download the receipt instead'); return; }
    var built = receiptPdf(r); if(!built) return;
    STATE.receiptForm = null;
    STATE.openOrderId = r.orderId;
    openOrderChat(phone);
    attachFileToChat(phone, built.blob, built.filename, 'application/pdf', 'Hi '+(r.customerName||'there')+', thank you for your payment of '+money(r.amount)+'. Here is your receipt '+r.number+'.');
    render();
  }

  function renderPaymentsSection(o){
    var st = payStatus(o);
    var list = STATE.receipts.filter(function(r){ return r.orderId===o.id; }).sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); });
    var rows = list.map(function(r){
      return '<div class="pay-row'+(r.voided?' voided':'')+'"><span class="mono">'+escapeHtml(r.number)+'</span><span>'+shortDate(r.date)+'</span><span>'+(r.method==='card'?'Card':'Cash')+(r.kind==='prepayment'?' · pre-payment':'')+'</span><span class="num">'+money(r.amount)+'</span>' +
        '<span class="pay-actions">' + (r.voided ? '<em>VOID</em>' :
          '<button class="btn btn-ghost btn-sm" data-action="receipt-pdf" data-id="'+r.id+'">PDF</button>' +
          (waPhone(r.phone) && STATE.mcp ? '<button class="btn btn-ghost btn-sm" data-action="receipt-wa" data-id="'+r.id+'">WhatsApp</button>' : '') +
          (isOwnerRole() && !r.cashupDate ? '<button class="btn btn-ghost btn-sm" data-action="receipt-void" data-id="'+r.id+'">Void</button>' : '')) +
        '</span></div>';
    }).join('');
    var chip = '<span class="pay-chip pay-'+st.key+'">'+st.label+'</span>';
    return (
      '<div class="field" style="background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">' +
          '<span style="font-size:12.5px; color:var(--ink-soft);"><strong style="color:var(--ink);">Payments</strong> '+chip+'</span>' +
          '<span style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">' +
            (canIssueCredit(o) ? '<button class="btn btn-sm" data-action="cn-new" data-id="'+o.id+'">Issue credit note</button>' : '') +
            '<button class="btn btn-sm" data-action="receipt-new" data-id="'+o.id+'">Receive payment</button>' +
          '</span>' +
        '</div>' +
        '<div style="font-size:12.5px; color:var(--ink-soft); margin-bottom:'+(rows||st.credited?'8px':'0')+';">'+(hasInvoiceDoc(o)?'Invoice total ':'Quoted ')+money(round2(st.due + (st.credited||0)))+(st.credited?(' &middot; Credited '+money(st.credited)):'')+' &middot; Paid '+money(st.paid)+' &middot; <strong style="color:var(--ink);">Balance '+money(Math.max(0,st.balance))+'</strong></div>' +
        rows + renderCreditRows(o) +
      '</div>'
    );
  }

  function renderReceiptModal(){
    var f = STATE.receiptForm; if(!f) return '';
    var o = STATE.orders.find(function(x){ return x.id===f.orderId; }); if(!o) return '';
    if(f.saved){
      var r = f.saved;
      return '<div class="overlay" data-action="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Receipt saved" style="max-width:460px;">' +
        '<div class="modal-head"><div><div class="jobno mono">'+escapeHtml(r.number)+'</div><h2>Receipt saved</h2></div><button class="modal-close" data-action="receipt-close" aria-label="Close">&times;</button></div>' +
        '<p style="margin-top:0;">'+money(r.amount)+' '+(r.method==='card'?'card':'cash')+' payment from '+escapeHtml(r.customerName)+' on '+fullDate(r.date)+'.</p>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-ghost" data-action="receipt-close">Done</button>' +
          '<button class="btn" data-action="receipt-pdf" data-id="'+r.id+'">Download PDF</button>' +
          (waPhone(r.phone) && STATE.mcp ? '<button class="btn btn-primary" data-action="receipt-wa" data-id="'+r.id+'">Send via WhatsApp</button>' : '') +
        '</div></div></div>';
    }
    var st = payStatus(o);
    return '<div class="overlay" data-action="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Receive payment" style="max-width:460px;">' +
      '<div class="modal-head"><div><div class="jobno mono">'+escapeHtml(o.jobNumber||jobNo(o.id))+'</div><h2>Receive payment</h2></div><button class="modal-close" data-action="receipt-close" aria-label="Close">&times;</button></div>' +
      '<p class="hint" style="margin-top:0;">'+escapeHtml(o.customerName)+' &middot; '+escapeHtml(o.title||'')+'<br>'+(hasInvoiceDoc(o)?('Invoice '+escapeHtml(o.invoiceNumber)+' — '):'No invoice yet, so this is recorded as a <strong>pre-payment</strong>. ')+'Balance '+money(Math.max(0,st.balance))+'.</p>' +
      (f.error ? '<div class="field-error" style="margin-bottom:8px;">'+escapeHtml(f.error)+'</div>' : '') +
      '<div class="field"><label for="rfAmount">Amount received ('+escapeHtml(STATE.config.currency||'ZAR')+')</label><input type="number" step="0.01" min="0" id="rfAmount" data-rf="amount" value="'+escapeHtml(String(f.amount))+'"></div>' +
      '<div class="field"><label>Paid by</label><div style="display:flex; gap:8px;">' +
        '<button type="button" class="chip-toggle '+(f.method==='cash'?'active':'')+'" data-action="receipt-method" data-m="cash">Cash</button>' +
        '<button type="button" class="chip-toggle '+(f.method==='card'?'active':'')+'" data-action="receipt-method" data-m="card">Card</button>' +
      '</div></div>' +
      '<div class="field"><label for="rfDate">Date</label><input type="date" id="rfDate" data-rf="date" value="'+escapeHtml(f.date)+'"></div>' +
      '<div class="field"><label for="rfNote">Note (optional)</label><input type="text" id="rfNote" data-rf="note" placeholder="e.g. 80% deposit" value="'+escapeHtml(f.note||'')+'"></div>' +
      '<div class="modal-foot"><button class="btn btn-ghost" data-action="receipt-close">Cancel</button><button class="btn btn-primary" data-action="receipt-save" '+(f.busy?'disabled':'')+'>'+(f.busy?'Saving…':'Save receipt')+'</button></div>' +
    '</div></div>';
  }

  /* ============================ cash-ups ============================ */
  function receiptsOn(date){ return STATE.receipts.filter(function(r){ return r.date===date && !r.voided; }).sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); }); }
  function defaultFloat(){ var f = Number(STATE.config.cashFloat); return isNaN(f) || STATE.config.cashFloat==null || STATE.config.cashFloat==='' ? 350 : f; }
  function cashupFormFor(date){
    var c = STATE.cashups[date];
    return c ? {date:date, cashCounted:String(c.cashCounted), cardTotal:String(c.cardTotal), float:String(c.float), notes:c.notes||'', denoms:Object.assign({}, c.denominations||{})}
             : {date:date, cashCounted:'', cardTotal:'', float:String(defaultFloat()), notes:'', denoms:{}};
  }
  /* Cash calculator — count the drawer by note and coin. */
  var CASH_DENOMS = [
    {key:'n200', value:200, label:'R200', type:'Notes'}, {key:'n100', value:100, label:'R100', type:'Notes'},
    {key:'n50', value:50, label:'R50', type:'Notes'}, {key:'n20', value:20, label:'R20', type:'Notes'},
    {key:'n10', value:10, label:'R10', type:'Notes'},
    {key:'c5', value:5, label:'R5', type:'Coins'}, {key:'c2', value:2, label:'R2', type:'Coins'},
    {key:'c1', value:1, label:'R1', type:'Coins'}, {key:'c050', value:0.5, label:'50c', type:'Coins'},
    {key:'c020', value:0.2, label:'20c', type:'Coins'}, {key:'c010', value:0.1, label:'10c', type:'Coins'}
  ];
  function denomQty(f, key){ var q = parseInt((f.denoms||{})[key], 10); return isNaN(q) || q < 0 ? 0 : q; }
  function denomTotals(f){
    var notes = 0, coins = 0, used = false;
    CASH_DENOMS.forEach(function(d){ var q = denomQty(f, d.key); if(q) used = true; var v = q * d.value; if(d.type==='Notes') notes += v; else coins += v; });
    return {notes:round2(notes), coins:round2(coins), total:round2(notes+coins), used:used};
  }
  function renderCashCalculator(f, dis){
    var t = denomTotals(f), lastType = '';
    var rows = CASH_DENOMS.map(function(d){
      var q = denomQty(f, d.key), head = '';
      if(d.type !== lastType){ lastType = d.type; head = '<tr class="den-head"><td colspan="3">'+d.type+'</td></tr>'; }
      return head + '<tr><td>'+d.label+'</td><td><input type="number" min="0" step="1" inputmode="numeric" class="den-qty" data-den="'+d.key+'" aria-label="Number of '+d.label+' '+d.type.toLowerCase()+'" value="'+(q||'')+'"'+dis+'></td><td class="num" id="den-'+d.key+'">'+money(q*d.value)+'</td></tr>';
    }).join('');
    return '<details class="cash-calc"'+(t.used || !f.cashCounted ? ' open' : '')+'><summary>Cash calculator &mdash; count notes and coins</summary>' +
      '<div class="tbl-wrap"><table class="cashup-table den-table"><thead><tr><th>Note / coin</th><th>Quantity</th><th>Value</th></tr></thead><tbody>' + rows +
      '</tbody><tfoot>' +
        '<tr><td>Notes</td><td></td><td class="num" id="denNotes">'+money(t.notes)+'</td></tr>' +
        '<tr><td>Coins</td><td></td><td class="num" id="denCoins">'+money(t.coins)+'</td></tr>' +
        '<tr style="font-weight:700;"><td>Total in drawer</td><td></td><td class="num" id="denTotal">'+money(t.total)+'</td></tr>' +
      '</tfoot></table></div>' +
      '<div class="hint">The total fills in “Cash counted in drawer” below. The float is deducted after that.</div>' +
    '</details>';
  }
  function onDenomInput(key, val){
    var f = STATE.cashupForm; if(!f) return;
    f.denoms = f.denoms || {}; f.denoms[key] = val;
    var d = CASH_DENOMS.find(function(x){ return x.key===key; });
    var cell = document.getElementById('den-'+key); if(cell && d) cell.innerHTML = money(denomQty(f, key) * d.value);
    var t = denomTotals(f);
    var set = function(id, html){ var el = document.getElementById(id); if(el) el.innerHTML = html; };
    set('denNotes', money(t.notes)); set('denCoins', money(t.coins)); set('denTotal', money(t.total));
    f.cashCounted = t.used ? t.total.toFixed(2) : '';
    var cash = document.getElementById('cuCash'); if(cash) cash.value = f.cashCounted;
    refreshCashupTotals();
  }
  function cashupCalc(date, f){
    var recs = receiptsOn(date);
    var cashExp = round2(recs.filter(function(r){ return r.method==='cash'; }).reduce(function(s,r){ return s+Number(r.amount||0); }, 0));
    var cardExp = round2(recs.filter(function(r){ return r.method==='card'; }).reduce(function(s,r){ return s+Number(r.amount||0); }, 0));
    var counted = round2(f.cashCounted), flt = round2(f.float), card = round2(f.cardTotal);
    var cashTakings = round2(counted - flt);
    var cashDiff = round2(cashTakings - cashExp), cardDiff = round2(card - cardExp);
    return {recs:recs, cashExp:cashExp, cardExp:cardExp, counted:counted, float:flt, card:card, cashTakings:cashTakings, cashDiff:cashDiff, cardDiff:cardDiff,
            totalExp:round2(cashExp+cardExp), totalActual:round2(cashTakings+card), totalDiff:round2(cashDiff+cardDiff)};
  }
  function diffLabel(d){ return Math.abs(d)<0.005 ? '<span class="pay-chip pay-paid">Balanced</span>' : (d>0 ? '<span class="pay-chip pay-part">Over '+money(d)+'</span>' : '<span class="pay-chip pay-unpaid">Short '+money(-d)+'</span>'); }

  function saveCashup(){
    var date = STATE.cashupDate, f = STATE.cashupForm; if(!f) return;
    if(!canCashup()){ toast('Only the owner and people allowed on the Team tab can cash up.'); return; }
    if(f.cashCounted==='' || isNaN(Number(f.cashCounted))){ toast('Enter the cash counted in the drawer'); return; }
    if(f.cardTotal==='' || isNaN(Number(f.cardTotal))){ toast('Enter the card machine total (0 if none)'); return; }
    var calc = cashupCalc(date, f);
    var member = currentTeamMember();
    var data = {date:date, cashCounted:calc.counted, float:calc.float, cardTotal:calc.card, cashTakings:calc.cashTakings,
      cashExpected:calc.cashExp, cardExpected:calc.cardExp, cashDifference:calc.cashDiff, cardDifference:calc.cardDiff, totalDifference:calc.totalDiff,
      receiptIds:calc.recs.map(function(r){ return r.id; }), receiptCount:calc.recs.length, notes:String(f.notes||'').trim(),
      denominations:(function(){ var o = {}; CASH_DENOMS.forEach(function(d){ var q = denomQty(f, d.key); if(q) o[d.key] = q; }); return o; })(),
      closedBy: member ? member.name : 'Owner', closedAt:new Date().toISOString()};
    var lock = calc.recs.map(function(r){ return {path:'receipts/'+r.id, data:{cashupDate:date}}; });
    var done = function(){ toast('Cash-up for '+fullDate(date)+' saved'); render(); };
    if(STATE.isLive && STATE.db){
      STATE.db.doc('cashups/'+date).set(data).then(function(){ return updateDocs(lock); }).then(done).catch(function(){ toast('Could not save the cash-up — try again'); });
    } else { STATE.cashups[date] = data; calc.recs.forEach(function(r){ r.cashupDate = date; }); done(); }
  }
  function reopenCashup(date){
    if(!isOwnerRole()) return;
    if(!confirm('Reopen the cash-up for '+fullDate(date)+'? Its receipts can then be changed again, and it must be cashed up again afterwards.')) return;
    var recs = STATE.receipts.filter(function(r){ return r.cashupDate===date; });
    if(STATE.isLive && STATE.db){
      STATE.db.doc('cashups/'+date).delete().then(function(){
        return updateDocs(recs.map(function(r){ return {path:'receipts/'+r.id, data:{cashupDate:null}}; }));
      }).then(function(){ STATE.cashupForm = cashupFormFor(date); render(); toast('Cash-up reopened'); }).catch(function(){ toast('Could not reopen — try again'); });
    } else { delete STATE.cashups[date]; recs.forEach(function(r){ r.cashupDate = null; }); STATE.cashupForm = cashupFormFor(date); render(); }
  }
  function exportCashupCsv(date){
    var c = STATE.cashups[date]; var f = STATE.cashupForm || cashupFormFor(date); var calc = cashupCalc(date, c ? {cashCounted:c.cashCounted, float:c.float, cardTotal:c.cardTotal} : f);
    var lines = [['Receipt','Time','Customer','Job','Invoice','Method','Amount']];
    calc.recs.forEach(function(r){ lines.push([r.number, String(r.createdAt).slice(11,16), r.customerName, r.jobNumber, r.invoiceNumber, r.method, Number(r.amount).toFixed(2)]); });
    lines.push([]);
    var fd = c ? {denoms:c.denominations||{}} : f;
    CASH_DENOMS.forEach(function(d){ var q = denomQty(fd, d.key); if(q) lines.push([d.label+' x '+q,'','','','','',(q*d.value).toFixed(2)]); });
    lines.push(['Cash counted','','','','','',calc.counted.toFixed(2)]);
    lines.push(['Less float','','','','','',calc.float.toFixed(2)]);
    lines.push(['Cash takings','','','','','',calc.cashTakings.toFixed(2)]);
    lines.push(['Cash receipts','','','','','',calc.cashExp.toFixed(2)]);
    lines.push(['Cash difference','','','','','',calc.cashDiff.toFixed(2)]);
    lines.push(['Card machine total','','','','','',calc.card.toFixed(2)]);
    lines.push(['Card receipts','','','','','',calc.cardExp.toFixed(2)]);
    lines.push(['Card difference','','','','','',calc.cardDiff.toFixed(2)]);
    var csv = lines.map(function(l){ return l.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([csv], {type:'text/csv'}), name = 'DsignX-cash-up-'+date+'.csv';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* Receipts export — bank statement import layout:
     *Date,*Amount,Payee,Description,Reference,Check Number  (dates DD/MM/YYYY) */
  function receiptExportDefaults(){
    var t = todayIso();
    if(!STATE.rxFrom) STATE.rxFrom = t.slice(0,8)+'01';
    if(!STATE.rxTo) STATE.rxTo = t;
    if(!STATE.rxMethod) STATE.rxMethod = 'all';
  }
  function receiptsBetween(from, to, method){
    return STATE.receipts.filter(function(r){
      return !r.voided && r.date>=from && r.date<=to && (method==='all' || r.method===method);
    }).sort(function(a,b){ return String(a.date+a.createdAt).localeCompare(String(b.date+b.createdAt)); });
  }
  function ddmmyyyy(iso){ var p = String(iso||'').split('-'); return p.length===3 ? p[2]+'/'+p[1]+'/'+p[0] : ''; }
  function receiptExportRows(recs){
    return recs.map(function(r){
      var what = (r.method==='card' ? 'Card' : 'Cash') + (r.kind==='prepayment' ? ' deposit' : ' payment');
      var job = [r.jobNumber, r.jobTitle].filter(Boolean).join(' ');
      return [ddmmyyyy(r.date), Number(r.amount).toFixed(2), r.customerName||'', what + (job ? ' - '+job : ''), [r.number, r.invoiceNumber].filter(Boolean).join(' / '), ''];
    });
  }
  function exportReceiptsCsv(){
    receiptExportDefaults();
    var from = STATE.rxFrom, to = STATE.rxTo, method = STATE.rxMethod;
    if(from > to){ toast('The From date is after the To date.'); return; }
    var recs = receiptsBetween(from, to, method);
    if(!recs.length){ toast('No receipts in that period.'); return; }
    var lines = [['*Date','*Amount','Payee','Description','Reference','Check Number']].concat(receiptExportRows(recs));
    var csv = lines.map(function(l){ return l.map(csvCell).join(','); }).join('\r\n') + '\r\n';
    var blob = new Blob([csv], {type:'text/csv'});
    var name = 'DsignX-receipts-'+from+'-to-'+to+(method==='all'?'':'-'+method)+'.csv';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
    toast(recs.length+' receipt'+(recs.length===1?'':'s')+' downloaded');
  }
  function renderReceiptExportPanel(){
    receiptExportDefaults();
    var recs = STATE.rxFrom <= STATE.rxTo ? receiptsBetween(STATE.rxFrom, STATE.rxTo, STATE.rxMethod) : [];
    var total = recs.reduce(function(s,r){ return s + (Number(r.amount)||0); }, 0);
    var opt = function(v,l){ return '<option value="'+v+'"'+(STATE.rxMethod===v?' selected':'')+'>'+l+'</option>'; };
    return '<div class="panel">' +
      '<div class="section-label">Download receipts (bank statement import template)</div>' +
      '<div class="field-row" style="align-items:flex-end;">' +
        '<div class="field"><label for="rxFrom">From</label><input type="date" id="rxFrom" value="'+STATE.rxFrom+'"></div>' +
        '<div class="field"><label for="rxTo">To</label><input type="date" id="rxTo" value="'+STATE.rxTo+'"></div>' +
        '<div class="field"><label for="rxMethod">Payment method</label><select id="rxMethod">'+opt('all','Cash and card')+opt('cash','Cash only')+opt('card','Card only')+'</select></div>' +
        '<div class="field"><button class="btn btn-primary btn-sm" data-action="receipts-export">Download CSV</button></div>' +
      '</div>' +
      '<div class="hint" id="rxSummary">'+(STATE.rxFrom > STATE.rxTo ? 'The From date is after the To date.' : recs.length+' receipt'+(recs.length===1?'':'s')+' &middot; '+money(total)+' (voided receipts are left out)')+'</div>' +
      '<div class="hint">Columns: *Date, *Amount, Payee, Description, Reference, Check Number &mdash; ready for bank statement import.</div>' +
    '</div>';
  }

  function renderCashupTab(){
    var date = STATE.cashupDate || todayIso();
    STATE.cashupDate = date;
    if(!STATE.cashupForm || STATE.cashupForm.date!==date) STATE.cashupForm = cashupFormFor(date);
    var f = STATE.cashupForm, closed = STATE.cashups[date];
    var calc = cashupCalc(date, f);
    var late = closed ? calc.recs.filter(function(r){ return (closed.receiptIds||[]).indexOf(r.id)<0; }) : [];
    var dis = closed ? ' disabled' : '';
    var recRows = calc.recs.length ? calc.recs.map(function(r){
      return '<tr><td class="mono">'+escapeHtml(r.number)+'</td><td>'+escapeHtml(String(r.createdAt).slice(11,16))+'</td><td class="row-btn" data-action="open-order" data-id="'+r.orderId+'">'+escapeHtml(r.customerName)+'</td><td class="mono">'+escapeHtml(r.jobNumber||'')+'</td><td>'+(r.method==='card'?'Card':'Cash')+'</td><td class="num">'+money(r.amount)+'</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty-note">No receipts captured for this day.</td></tr>';
    var history = Object.keys(STATE.cashups).sort().reverse().slice(0,14).map(function(d){
      var c = STATE.cashups[d];
      return '<tr class="row-btn" data-action="cashup-date" data-date="'+d+'"><td>'+fullDate(d)+'</td><td class="num">'+money(c.cashTakings)+'</td><td class="num">'+money(c.cardTotal)+'</td><td>'+diffLabel(Number(c.totalDifference)||0)+'</td><td>'+escapeHtml(c.closedBy||'')+'</td></tr>';
    }).join('');
    return (
      '<div class="topline"><div><h1>Cash-ups</h1><div class="sub">Count the drawer at the end of the day and match it to the receipts captured.</div></div></div>' +
      '<div class="panel">' +
        '<div class="field-row" style="align-items:flex-end;">' +
          '<div class="field"><label for="cuDate">Day</label><input type="date" id="cuDate" value="'+date+'"></div>' +
          '<div class="field">'+(closed ? '<span class="pay-chip pay-paid">Cashed up by '+escapeHtml(closed.closedBy||'')+'</span>' : '<span class="pay-chip pay-part">Open</span>')+'</div>' +
        '</div>' +
        (late.length ? '<div class="hint" style="color:var(--critical); margin-bottom:8px;">'+late.length+' receipt(s) were captured after this cash-up was saved. Ask the owner to reopen and redo it.</div>' : '') +
        '<div class="section-label" style="margin-top:6px;">Receipts captured</div>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Receipt</th><th>Time</th><th>Customer</th><th>Job</th><th>Method</th><th>Amount</th></tr></thead><tbody>'+recRows+'</tbody></table></div>' +
        '<div class="hint" style="margin-top:6px;">Cash '+money(calc.cashExp)+' &middot; Card '+money(calc.cardExp)+' &middot; Total '+money(calc.totalExp)+'</div>' +
      '</div>' +
      '<div class="panel">' +
        '<div class="section-label">Count</div>' +
        renderCashCalculator(f, dis) +
        '<div class="field-row">' +
          '<div class="field"><label for="cuCash">Cash counted in drawer</label><input type="number" step="0.01" min="0" id="cuCash" data-cu="cashCounted" value="'+escapeHtml(f.cashCounted)+'"'+dis+'></div>' +
          '<div class="field"><label for="cuFloat">Less float</label><input type="number" step="0.01" min="0" id="cuFloat" data-cu="float" value="'+escapeHtml(f.float)+'"'+dis+'></div>' +
          '<div class="field"><label for="cuCard">Card machine total (batch slip)</label><input type="number" step="0.01" min="0" id="cuCard" data-cu="cardTotal" value="'+escapeHtml(f.cardTotal)+'"'+dis+'></div>' +
        '</div>' +
        '<div class="tbl-wrap"><table class="cashup-table"><thead><tr><th></th><th>Counted</th><th>Receipts</th><th>Difference</th></tr></thead><tbody>' +
          '<tr><td>Cash (after float)</td><td class="num" id="cuCashTakings">'+money(calc.cashTakings)+'</td><td class="num">'+money(calc.cashExp)+'</td><td id="cuCashDiff">'+diffLabel(calc.cashDiff)+'</td></tr>' +
          '<tr><td>Card</td><td class="num" id="cuCardActual">'+money(calc.card)+'</td><td class="num">'+money(calc.cardExp)+'</td><td id="cuCardDiff">'+diffLabel(calc.cardDiff)+'</td></tr>' +
          '<tr style="font-weight:700;"><td>Total</td><td class="num" id="cuTotalActual">'+money(calc.totalActual)+'</td><td class="num">'+money(calc.totalExp)+'</td><td id="cuTotalDiff">'+diffLabel(calc.totalDiff)+'</td></tr>' +
        '</tbody></table></div>' +
        '<div class="field" style="margin-top:10px;"><label for="cuNotes">Notes (explain any difference)</label><input type="text" id="cuNotes" data-cu="notes" value="'+escapeHtml(f.notes||'')+'"'+dis+'></div>' +
        (closed
          ? (isOwnerRole() ? '<button class="btn btn-sm" data-action="cashup-reopen" data-date="'+date+'">Reopen cash-up</button> ' : '')
          : '<button class="btn btn-primary btn-sm" data-action="cashup-save">Save cash-up</button> ') +
        '<button class="btn btn-ghost btn-sm" data-action="cashup-csv" data-date="'+date+'">Download CSV</button>' +
      '</div>' +
      renderReceiptExportPanel() +
      (history ? '<div class="panel"><div class="section-label">Recent cash-ups</div><div class="tbl-wrap"><table><thead><tr><th>Day</th><th>Cash takings</th><th>Card</th><th>Result</th><th>By</th></tr></thead><tbody>'+history+'</tbody></table></div></div>' : '')
    );
  }
  function refreshCashupTotals(){
    var date = STATE.cashupDate, f = STATE.cashupForm; if(!f) return;
    var c = cashupCalc(date, f);
    var set = function(id, html){ var el = document.getElementById(id); if(el) el.innerHTML = html; };
    set('cuCashTakings', money(c.cashTakings)); set('cuCardActual', money(c.card)); set('cuTotalActual', money(c.totalActual));
    set('cuCashDiff', diffLabel(c.cashDiff)); set('cuCardDiff', diffLabel(c.cardDiff)); set('cuTotalDiff', diffLabel(c.totalDiff));
  }

  /* ============================ WhatsApp templates ============================ */
  // Approved (by Meta) message templates — the only messages WhatsApp delivers once
  // 24 hours have passed since the customer last wrote.
  function custFirstName(o){
    var c = STATE.customers.find(function(x){ return x.id===o.customerId; });
    if(c && c.firstName) return c.firstName;
    return o.customerName || 'there';
  }
  var WA_TEMPLATES = [
    {slug:'dsignx_walk_in', label:'Walk-in customer (first message)',
      text:'Hi {{customer_name}}, thank you for visiting DsignX. We will use this WhatsApp number to send you the quotation, proofs and updates for {{job_title}}. Please reply to this message so we can send your documents here.',
      params:function(o){ return {customer_name:custFirstName(o), job_title:(o.title && o.title!=='Quotation' && o.title!=='Untitled job') ? o.title : 'your order'}; }},
    {slug:'dsignx_follow_up', label:'General follow-up',
      text:'Hi {{customer_name}}, this is DsignX following up on your recent enquiry with us. Please reply to this message so we can continue helping you.',
      params:function(o){ return {customer_name:custFirstName(o)}; }},
    {slug:'dsignx_quote_ready', label:'Quote ready',
      text:'Hi {{customer_name}}, your quotation {{quote_number}} for {{job_title}} is ready. Reply to this message and we will send it to you here.',
      needs:function(o){ return o.quoteNumber ? '' : 'Generate the quotation first.'; },
      params:function(o){ return {customer_name:custFirstName(o), quote_number:o.quoteNumber||'', job_title:o.title||'your job'}; }},
    {slug:'dsignx_order_ready', label:'Order ready for collection',
      text:'Hi {{customer_name}}, good news! Your order {{order_ref}} is ready for collection at DsignX, Corcomm Building, 36 Reitz Street, Kroonstad.',
      params:function(o){ return {customer_name:custFirstName(o), order_ref:(o.jobNumber||jobNo(o.id))+(o.title?(' ('+o.title+')'):'')}; }},
    {slug:'dsignx_payment_reminder', label:'Payment reminder',
      text:'Hi {{customer_name}}, this is a friendly reminder that invoice {{invoice_number}} for {{amount}} is due on {{due_date}}. Please use the invoice number as your payment reference. Thank you!',
      needs:function(o){ if (!hasInvoiceDoc(o)) return 'Generate the invoice first.'; return payStatus(o).balance > 0.004 ? '' : 'This invoice is fully paid.'; },
      params:function(o){ var st = payStatus(o); return {customer_name:custFirstName(o), invoice_number:o.invoiceNumber||'', amount:money(Math.max(0,st.balance)), due_date:fullDate(addDays(o.invoiceGeneratedAt||todayIso(), o.invoiceDueDays!=null?Number(o.invoiceDueDays):(Number(STATE.config.invoiceDueDays)||7)))}; }}
  ];
  function fillTemplate(text, params){ return text.replace(/\{\{(\w+)\}\}/g, function(m, k){ return params[k]!=null ? params[k] : m; }); }
  function prepareTemplate(phone, slug){
    var o = STATE.orders.find(function(x){ return x.id===STATE.openOrderId; });
    if(!o && STATE.inboxReply && STATE.inboxReply.phone===phone) o = inboxContact(phone, STATE.inboxReply.name);
    if(!o) return;
    var t = WA_TEMPLATES.find(function(x){ return x.slug===slug; }); if(!t) return;
    var why = t.needs ? t.needs(o) : '';
    if(why){ toast(why); return; }
    var params = t.params(o);
    var entry = Object.assign({}, STATE.chatMessages[phone]);
    entry.sendError = null;
    entry.pendingSend = {kind:'template', slug:t.slug, label:t.label, params:params, text:fillTemplate(t.text, params)};
    STATE.chatMessages[phone] = entry;
    render();
  }
  function templateContent(p){
    return {template:{slug:p.slug, language:'en', components:[{type:'body', parameters:Object.keys(p.params).map(function(k){ return {type:'text', name:k, text:String(p.params[k])}; })}]}};
  }
  function templatePicker(phone){
    return '<div class="tpl-row"><select id="tplPick" data-phone="'+phone+'"><option value="">Send an approved template…</option>' +
      WA_TEMPLATES.map(function(t){ return '<option value="'+t.slug+'">'+escapeHtml(t.label)+'</option>'; }).join('') +
      '</select></div>';
  }

  /* ============================ stock take ============================ */
  // Products carry a system quantity (stockQty). A stock take freezes those quantities,
  // prints a blank count sheet, takes the owner's counts, and on finalising writes a
  // variance report and sets each product's stockQty to the counted quantity.
  function stockQtyOf(p){ var n = Number(p && p.stockQty); return isFinite(n) ? n : 0; }
  function fmtQty(n){ n = Number(n)||0; return (Math.round(n*1000)/1000).toString(); }
  function openStocktake(){ return STATE.stocktakes.find(function(s){ return s.status==='open'; }) || null; }
  function stocktakeNo(st){ return st.number || ('ST-'+String(st.id||'').slice(-6).toUpperCase()); }
  function stocktakeCountsFor(st){ return Object.assign({}, st.counts||{}, STATE.stockDraft[st.id]||{}); }
  function parseCount(v){ if(v===undefined || v===null || String(v).trim()==='') return null; var n = Number(String(v).replace(',', '.')); return isFinite(n) && n>=0 ? n : NaN; }

  function startStocktake(){
    if(!isOwnerRole()) return;
    if(openStocktake()){ toast('A stock take is already open'); return; }
    var ticked = STATE.products.filter(function(p){ return p.stockItem; });
    if(!ticked.length){ toast('Tick “Count” on the products you want to include first'); return; }
    var items = ticked.slice().sort(function(a,b){ return String(a.description).localeCompare(String(b.description)); }).map(function(p){
      return {pid:p.id, code:p.code||'', description:p.description||'', unit:p.unit||'', price:Number(p.price)||0, system:stockQtyOf(p)};
    });
    var now = new Date(), stamp = now.toISOString();
    var d = localIso(now).replace(/-/g,'');
    var number = 'ST-' + d + '-' + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0');
    var data = {number:number, status:'open', startedAt:stamp, date:localIso(now), startedBy:'Owner', items:items, counts:{}};
    var id = number.toLowerCase();
    var done = function(){ toast('Stock take '+number+' started — print the count sheet'); render(); };
    if(STATE.isLive && STATE.db){ STATE.db.doc('stocktakes/'+id).set(data).then(done).catch(function(){ toast('Could not start the stock take — try again'); }); }
    else { STATE.stocktakes.push(Object.assign({id:id}, data)); done(); }
  }
  function cancelStocktake(id){
    if(!isOwnerRole()) return;
    if(!confirm('Cancel this stock take? Counts entered so far are discarded and no quantities change.')) return;
    if(STATE.isLive && STATE.db){ STATE.db.doc('stocktakes/'+id).delete().catch(function(){ toast('Could not cancel — try again'); }); }
    else { STATE.stocktakes = STATE.stocktakes.filter(function(s){ return s.id!==id; }); render(); }
    delete STATE.stockDraft[id];
  }
  var _stockSaveTimer = null;
  function onCountInput(stId, pid, val){
    STATE.stockDraft[stId] = STATE.stockDraft[stId] || {};
    STATE.stockDraft[stId][pid] = val;
    var st = STATE.stocktakes.find(function(s){ return s.id===stId; }); if(!st) return;
    var it = (st.items||[]).find(function(x){ return x.pid===pid; });
    var c = parseCount(val), cell = document.getElementById('stv-'+pid);
    if(cell && it){ cell.innerHTML = c===null ? '' : (isNaN(c) ? '<span style="color:var(--critical);">?</span>' : varianceHtml(c - it.system)); }
    var prog = document.getElementById('stProgress'); if(prog) prog.innerHTML = stocktakeProgressText(st);
    clearTimeout(_stockSaveTimer);
    _stockSaveTimer = setTimeout(function(){ saveStockCounts(stId); }, 800);
  }
  function saveStockCounts(stId){
    var st = STATE.stocktakes.find(function(s){ return s.id===stId; }); if(!st) return Promise.resolve();
    var counts = stocktakeCountsFor(st), clean = {};
    Object.keys(counts).forEach(function(k){ var c = parseCount(counts[k]); if(c!==null && !isNaN(c)) clean[k] = c; });
    st.counts = clean;
    if(STATE.isLive && STATE.db){ return STATE.db.doc('stocktakes/'+stId).update({counts:clean, updatedAt:new Date().toISOString()}).catch(function(){ toast('Counts not saved — check your connection'); }); }
    return Promise.resolve();
  }
  function stocktakeProgressText(st){
    var counts = stocktakeCountsFor(st), n = 0;
    (st.items||[]).forEach(function(it){ var c = parseCount(counts[it.pid]); if(c!==null && !isNaN(c)) n++; });
    return n+' of '+(st.items||[]).length+' products counted';
  }
  function varianceHtml(v){
    v = Math.round(v*1000)/1000;
    if(v===0) return '<span class="pay-chip pay-paid">0</span>';
    return '<span class="pay-chip '+(v>0?'pay-part':'pay-unpaid')+'">'+(v>0?'+':'')+fmtQty(v)+'</span>';
  }
  function stocktakeResults(st, counts, blanksAsZero){
    var rows = [], missing = [], bad = [];
    (st.items||[]).forEach(function(it){
      var c = parseCount(counts[it.pid]);
      if(c===null){ if(blanksAsZero) c = 0; else { missing.push(it); return; } }
      if(isNaN(c)){ bad.push(it); return; }
      var v = Math.round((c - it.system)*1000)/1000;
      rows.push({pid:it.pid, code:it.code, description:it.description, unit:it.unit, price:it.price, system:it.system, counted:c, variance:v, value:round2(v*it.price)});
    });
    var t = {items:rows.length, withVariance:rows.filter(function(r){ return r.variance!==0; }).length,
      gain:round2(rows.filter(function(r){ return r.value>0; }).reduce(function(s,r){ return s+r.value; },0)),
      loss:round2(rows.filter(function(r){ return r.value<0; }).reduce(function(s,r){ return s+r.value; },0))};
    t.net = round2(t.gain + t.loss);
    return {rows:rows, missing:missing, bad:bad, totals:t};
  }
  function finaliseStocktake(stId){
    if(!isOwnerRole()) return;
    var st = STATE.stocktakes.find(function(s){ return s.id===stId; }); if(!st) return;
    var counts = stocktakeCountsFor(st);
    var res = stocktakeResults(st, counts, false);
    if(res.bad.length){ toast('Check the count for '+res.bad[0].description+' — it isn’t a valid number'); return; }
    var blanksAsZero = false;
    if(res.missing.length){
      if(!confirm(res.missing.length+' product'+(res.missing.length===1?' has':'s have')+' no count (e.g. '+res.missing[0].description+').\n\nOK = count them as 0 (none in stock).\nCancel = go back and count them.')) return;
      blanksAsZero = true;
      res = stocktakeResults(st, counts, true);
    }
    if(!confirm('Finalise stock take '+stocktakeNo(st)+'?\n\n'+res.totals.withVariance+' product(s) differ from the system. Net variance '+money(res.totals.net)+' (excl VAT).\n\nProduct quantities will be set to the counted quantities. This can’t be undone.')) return;
    var now = new Date().toISOString();
    var existing = {}; STATE.products.forEach(function(p){ existing[p.id] = true; });
    var updates = res.rows.filter(function(r){ return existing[r.pid]; }).map(function(r){ return {path:'products/'+r.pid, data:{stockQty:r.counted, stockTakenAt:now, stocktakeId:st.id}}; });
    var fin = {status:'final', finalizedAt:now, finalizedBy:'Owner', counts:Object.fromEntries(res.rows.map(function(r){ return [r.pid, r.counted]; })), results:res.rows, totals:res.totals, blanksCountedAsZero:blanksAsZero};
    var after = function(){
      Object.assign(st, fin); delete STATE.stockDraft[st.id];
      if(!(STATE.isLive && STATE.db)){ res.rows.forEach(function(r){ var p = STATE.products.find(function(x){ return x.id===r.pid; }); if(p){ p.stockQty = r.counted; p.stockTakenAt = now; } }); }
      render(); toast('Stock take finalised — quantities updated');
      downloadVariancePdf(st);
    };
    if(STATE.isLive && STATE.db){
      updateDocs(updates).then(function(){ return STATE.db.doc('stocktakes/'+st.id).update(fin); }).then(after)
        .catch(function(){ toast('Could not finalise — nothing was changed. Try again.'); });
    } else after();
  }

  /* ---- PDFs ---- */
  function stockPdfHeader(doc, title, sub){
    var L = 15, R = 195, MAROON = [78,9,40], GREY = [95,99,88];
    try { doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 10, 40, 40*(358/800)); } catch(e){}
    doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(lh('docCompanyName'), R, 15, {align:'right'});
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(GREY[0],GREY[1],GREY[2]); doc.text(lh('docAddress'), R, 19.5, {align:'right'});
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 30, R-L, 0.8, 'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(17); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(title, L, 40);
    doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(60,60,60); doc.text(sub, L, 46);
    return 52;
  }
  function stockPdfSave(doc, name){
    var blob = doc.output('blob');
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }
  function downloadCountSheet(stId){
    var st = STATE.stocktakes.find(function(s){ return s.id===stId; }); if(!st) return;
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return; }
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195, rowH = 9, box = 6.2;
    var cols = {no:L, prod:L+9, counted:122, system:146, checked:170, w:22};
    var head = function(first){
      var y = stockPdfHeader(doc, 'STOCK TAKE — COUNT SHEET', stocktakeNo(st)+'   ·   Date: '+fullDate(st.date||localIso(new Date())));
      if(first){
        doc.setFontSize(9); doc.setTextColor(43,43,43);
        doc.text('Counted by: ______________________________', L, y+2); doc.text('Checked by: ______________________________', 108, y+2);
        y += 9;
      }
      doc.setFillColor(78,9,40); doc.rect(L, y, R-L, 8, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8); doc.setTextColor(255,255,255);
      doc.text('#', cols.no+1.5, y+5.3); doc.text('PRODUCT', cols.prod, y+5.3);
      ['COUNTED','SYSTEM','CHECKED'].forEach(function(t, i){ doc.text(t, [cols.counted,cols.system,cols.checked][i]+cols.w/2, y+5.3, {align:'center'}); });
      return y + 8;
    };
    var y = head(true), page = 1;
    (st.items||[]).forEach(function(it, i){
      if(y + rowH > 282){ doc.addPage(); page++; y = head(false); }
      if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, rowH, 'F'); }
      doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(120,120,112); doc.text(String(i+1), cols.no+1.5, y+5.8);
      doc.setTextColor(43,43,43);
      var label = (it.code ? it.code+'  ' : '') + it.description + (it.unit ? '  ('+it.unit+')' : '');
      doc.text(doc.splitTextToSize(label, cols.counted - cols.prod - 4)[0], cols.prod, y+5.8);
      doc.setDrawColor(90,90,90); doc.setLineWidth(0.3);
      [cols.counted, cols.system, cols.checked].forEach(function(x){ doc.rect(x + (cols.w-16)/2, y+(rowH-box)/2, 16, box); });
      doc.setDrawColor(222,222,216); doc.setLineWidth(0.15); doc.line(L, y+rowH, R, y+rowH);
      y += rowH;
    });
    y += 8; if(y > 270){ doc.addPage(); y = 20; }
    doc.setFontSize(8.5); doc.setTextColor(95,99,88);
    doc.text((st.items||[]).length+' products. Write the quantity you count in COUNTED. SYSTEM and CHECKED are completed afterwards.', L, y);
    var n = doc.getNumberOfPages();
    for(var i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140,140,132); doc.text('Page '+i+' of '+n, R, 290, {align:'right'}); }
    stockPdfSave(doc, 'DsignX-count-sheet-'+stocktakeNo(st)+'.pdf');
  }
  function downloadVariancePdf(st){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return; }
    var rows = st.results || [], t = st.totals || {};
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195;
    var X = {code:L+1.5, prod:L+22, unit:104, sys:126, cnt:142, var:158, price:176, val:R-1.5};
    var head = function(){
      var y = stockPdfHeader(doc, 'STOCK TAKE — VARIANCE REPORT', stocktakeNo(st)+'   ·   Started '+fullDate(String(st.startedAt||st.date).slice(0,10))+'   ·   Finalised '+fullDate(String(st.finalizedAt||'').slice(0,10)));
      doc.setFillColor(78,9,40); doc.rect(L, y, R-L, 8, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7.4); doc.setTextColor(255,255,255);
      doc.text('CODE', X.code, y+5.3); doc.text('PRODUCT', X.prod, y+5.3); doc.text('UNIT', X.unit, y+5.3);
      doc.text('SYSTEM', X.sys, y+5.3, {align:'right'}); doc.text('COUNTED', X.cnt+2, y+5.3, {align:'right'}); doc.text('VARIANCE', X.var+3, y+5.3, {align:'right'});
      doc.text('PRICE', X.price, y+5.3, {align:'right'}); doc.text('VALUE', X.val, y+5.3, {align:'right'});
      return y + 8;
    };
    var y = head();
    var sorted = rows.slice().sort(function(a,b){ return (Math.abs(b.value) - Math.abs(a.value)) || String(a.description).localeCompare(b.description); });
    sorted.forEach(function(r, i){
      if(y + 7 > 268){ doc.addPage(); y = head(); }
      if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, 7, 'F'); }
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(43,43,43);
      doc.text(String(r.code||''), X.code, y+4.8); doc.text(doc.splitTextToSize(String(r.description), X.unit-X.prod-3)[0], X.prod, y+4.8); doc.text(String(r.unit||''), X.unit, y+4.8);
      doc.text(fmtQty(r.system), X.sys, y+4.8, {align:'right'}); doc.text(fmtQty(r.counted), X.cnt+2, y+4.8, {align:'right'});
      if(r.variance<0) doc.setTextColor(150,30,30); else if(r.variance>0) doc.setTextColor(30,107,52);
      doc.setFont('helvetica', r.variance ? 'bold' : 'normal');
      doc.text((r.variance>0?'+':'')+fmtQty(r.variance), X.var+3, y+4.8, {align:'right'});
      doc.setFont('helvetica','normal'); doc.setTextColor(43,43,43); doc.text(money(r.price), X.price, y+4.8, {align:'right'});
      if(r.value<0) doc.setTextColor(150,30,30); else if(r.value>0) doc.setTextColor(30,107,52);
      doc.text(money(r.value), X.val, y+4.8, {align:'right'});
      y += 7;
    });
    y += 6; if(y > 250){ doc.addPage(); y = 20; }
    var line = function(label, val, bold){ doc.setFont('helvetica', bold?'bold':'normal'); doc.setFontSize(9); doc.setTextColor(43,43,43); doc.text(label, 120, y); doc.text(val, R-1.5, y, {align:'right'}); y += 5.5; };
    line('Products counted', String(t.items||rows.length)); line('Products with a variance', String(t.withVariance||0));
    line('Stock gained (excl VAT)', money(t.gain||0)); line('Stock lost (excl VAT)', money(t.loss||0)); line('Net variance (excl VAT)', money(t.net||0), true);
    if(st.blanksCountedAsZero){ y += 2; doc.setFont('helvetica','italic'); doc.setFontSize(8); doc.setTextColor(95,99,88); doc.text('Products left blank on the count were counted as 0.', L, y); }
    y += 10; doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(43,43,43);
    doc.text('Product quantities were set to the counted quantities when this stock take was finalised.', L, y);
    y += 12; doc.text('Signed: ______________________________          Date: ________________', L, y);
    var n = doc.getNumberOfPages();
    for(var i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140,140,132); doc.text('Page '+i+' of '+n, R, 290, {align:'right'}); }
    stockPdfSave(doc, 'DsignX-stock-variance-'+stocktakeNo(st)+'.pdf');
  }
  function downloadVarianceCsv(st){
    var lines = [['Code','Product','Unit','System qty','Counted qty','Variance','Unit price (excl VAT)','Variance value (excl VAT)']];
    (st.results||[]).forEach(function(r){ lines.push([r.code, r.description, r.unit, fmtQty(r.system), fmtQty(r.counted), fmtQty(r.variance), Number(r.price).toFixed(2), Number(r.value).toFixed(2)]); });
    var t = st.totals||{};
    lines.push([]); lines.push(['Net variance','','','','','','',Number(t.net||0).toFixed(2)]);
    var csv = lines.map(function(l){ return l.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob([csv], {type:'text/csv'}), name = 'DsignX-stock-variance-'+stocktakeNo(st)+'.csv';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* ---- panel on the Products tab ---- */
  function renderStocktakePanel(){
    var st = openStocktake();
    var history = STATE.stocktakes.filter(function(s){ return s.status==='final'; }).sort(function(a,b){ return String(b.finalizedAt).localeCompare(String(a.finalizedAt)); }).slice(0,10);
    var histHtml = history.length ? '<div class="section-label" style="margin-top:16px;">Completed stock takes</div><div class="tbl-wrap"><table><thead><tr><th>Stock take</th><th>Finalised</th><th class="num">Products</th><th class="num">With variance</th><th class="num">Net variance</th><th></th></tr></thead><tbody>' +
      history.map(function(h){ var t = h.totals||{}; return '<tr><td class="mono">'+escapeHtml(stocktakeNo(h))+'</td><td>'+fullDate(String(h.finalizedAt).slice(0,10))+'</td><td class="num">'+(t.items||0)+'</td><td class="num">'+(t.withVariance||0)+'</td><td class="num">'+money(t.net||0)+'</td>' +
        '<td style="white-space:nowrap;"><button class="btn btn-ghost btn-sm" data-action="stock-variance-pdf" data-id="'+h.id+'">Variance PDF</button><button class="btn btn-ghost btn-sm" data-action="stock-variance-csv" data-id="'+h.id+'">CSV</button></td></tr>'; }).join('') +
      '</tbody></table></div>' : '';
    if(!isOwnerRole()){
      return '<div class="panel"><div class="section-label">Stock take</div><p class="hint" style="margin:0;">'+(st ? 'Stock take '+escapeHtml(stocktakeNo(st))+' is in progress.' : 'Stock takes are done by the owner.')+'</p>'+histHtml+'</div>';
    }
    if(!st){
      return '<div class="panel"><div class="section-label">Stock take</div>' +
        '<p class="hint" style="margin-top:0;">Starting a stock take freezes the current system quantities. Print the count sheet, count the stock, enter the counts here and finalise — you get a variance report and the product quantities are updated to what was counted.</p>' +
        '<p class="hint">'+STATE.products.filter(function(p){ return p.stockItem; }).length+' of '+STATE.products.length+' products are ticked to be counted (the <strong>Count</strong> column below).</p>' +
        '<button class="btn btn-primary btn-sm" data-action="stock-start"'+(STATE.products.some(function(p){ return p.stockItem; })?'':' disabled')+'>Start stock take</button>' + histHtml + '</div>';
    }
    var counts = stocktakeCountsFor(st);
    var q = (STATE.stockQuery||'').trim().toLowerCase();
    var items = (st.items||[]).filter(function(it){ return !q || (it.code+' '+it.description).toLowerCase().indexOf(q)>=0; });
    var rows = items.map(function(it){
      var raw = counts[it.pid]; var c = parseCount(raw);
      return '<tr><td class="mono">'+escapeHtml(it.code)+'</td><td>'+escapeHtml(it.description)+(it.unit?' <span style="color:var(--ink-faint);">('+escapeHtml(it.unit)+')</span>':'')+'</td>' +
        '<td class="num">'+fmtQty(it.system)+'</td>' +
        '<td><input type="number" min="0" step="any" inputmode="decimal" class="st-count" data-st="'+st.id+'" data-pid="'+it.pid+'" value="'+(raw===undefined||raw===null?'':escapeHtml(String(raw)))+'" aria-label="Counted quantity for '+escapeHtml(it.description)+'"></td>' +
        '<td id="stv-'+it.pid+'">'+(c===null?'':(isNaN(c)?'?':varianceHtml(c - it.system)))+'</td></tr>';
    }).join('');
    return '<div class="panel stocktake-panel"><div class="section-label" style="display:flex; justify-content:space-between; align-items:center;">Stock take '+escapeHtml(stocktakeNo(st))+' <span class="pay-chip pay-part">In progress</span></div>' +
      '<div class="hint" style="margin-top:0;">Started '+fullDate(st.date)+'. Print the count sheet, count the stock, then type the counted quantities below. Counts save as you type.</div>' +
      '<div class="field-row" style="align-items:center; margin:10px 0;">' +
        '<div><button class="btn btn-sm" data-action="stock-sheet" data-id="'+st.id+'">Print count sheet (PDF)</button></div>' +
        '<div class="field" style="margin:0;"><input type="search" id="stockSearch" placeholder="Find a product…" value="'+escapeHtml(STATE.stockQuery||'')+'"></div>' +
      '</div>' +
      '<div class="tbl-wrap"><table class="stock-table"><thead><tr><th>Code</th><th>Product</th><th class="num">System</th><th>Counted</th><th>Variance</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5" class="empty-note">No products match.</td></tr>')+'</tbody></table></div>' +
      '<div class="hint" id="stProgress" style="margin:8px 0;">'+stocktakeProgressText(st)+'</div>' +
      '<button class="btn btn-primary btn-sm" data-action="stock-finalise" data-id="'+st.id+'">Finalise stock take</button> ' +
      '<button class="btn btn-ghost btn-sm" data-action="stock-cancel" data-id="'+st.id+'">Cancel stock take</button>' +
      histHtml + '</div>';
  }

  function toggleStockItem(id, on){
    var p = STATE.products.find(function(x){ return x.id===id; }); if(!p) return;
    p.stockItem = !!on;
    if(STATE.isLive && STATE.db){ STATE.db.doc('products/'+id).update({stockItem:!!on}).catch(function(){ toast('Could not save — try again'); render(); }); }
    render();
  }
  function setAllStockItems(on){
    var list = STATE.products.filter(function(p){ return !!p.stockItem !== !!on; });
    if(!list.length) return;
    if(!confirm((on?'Tick':'Untick')+' all '+list.length+' products for stock takes?')) return;
    list.forEach(function(p){ p.stockItem = !!on; });
    updateDocs(list.map(function(p){ return {path:'products/'+p.id, data:{stockItem:!!on}}; })).catch(function(){ toast('Could not save — try again'); });
    render();
  }

  // Re-render without losing the count box the owner is typing in.
  function renderKeepCountFocus(){
    var a = document.activeElement, pid = a && a.classList && a.classList.contains('st-count') ? a.getAttribute('data-pid') : null;
    var pos = pid ? a.selectionStart : null;
    render();
    if(pid){ var el = document.querySelector('.st-count[data-pid="'+pid+'"]'); if(el){ el.focus(); try{ if(pos!=null) el.setSelectionRange(pos, pos); }catch(e){} } }
  }

  /* ---- invoices take stock out ---- */
  // Lines on an invoice whose description matches a product ticked for stock reduce that
  // product's quantity. The job remembers what it took (stockDeducted), so editing the
  // invoice later only moves the difference — nothing is taken twice.
  function invoiceStockNeeds(lines){
    var need = {};
    (lines||[]).forEach(function(li){
      var p = findProductByDescription(li.description);
      var q = Number(li.qty)||0;
      if(p && p.stockItem && q>0) need[p.id] = Math.round(((need[p.id]||0) + q)*1000)/1000;
    });
    return need;
  }
  function syncInvoiceStock(orderId, lines){
    var o = STATE.orders.find(function(x){ return x.id===orderId; }); if(!o) return Promise.resolve();
    var prev = o.stockDeducted || {}, want = invoiceStockNeeds(lines);
    var exists = {}; STATE.products.forEach(function(p){ exists[p.id] = true; });
    Object.keys(want).forEach(function(k){ if(!exists[k]) delete want[k]; });
    var deltas = [];
    Object.keys(Object.assign({}, prev, want)).forEach(function(pid){
      var d = Math.round(((want[pid]||0) - (prev[pid]||0))*1000)/1000;
      if(d!==0 && exists[pid]) deltas.push({pid:pid, qty:d});
    });
    if(!deltas.length && JSON.stringify(prev)===JSON.stringify(want)) return Promise.resolve();
    var out = deltas.reduce(function(s,d){ return s + d.qty; }, 0);
    var note = function(){
      if(!deltas.length) return;
      STATE.stockNote = out>0 ? (fmtQty(out)+' item'+(out===1?'':'s')+' taken out of stock') : (out<0 ? (fmtQty(-out)+' item'+(out===-1?'':'s')+' put back in stock') : 'stock updated');
    };
    if(STATE.isLive && window.DSX && window.DSX.adjustStock){
      return window.DSX.adjustStock(orderId, want, deltas).then(function(){ o.stockDeducted = want; note(); })
        .catch(function(){ toast('Invoice saved, but stock could not be updated — save the invoice again'); });
    }
    deltas.forEach(function(d){ var p = STATE.products.find(function(x){ return x.id===d.pid; }); if(p) p.stockQty = stockQtyOf(p) - d.qty; });
    o.stockDeducted = want; note();
    return Promise.resolve();
  }
  /* ============================ reports: daily cash-up ============================ */
  // One row per day in the period: what was counted against what the receipts say.
  // Days with receipts but no saved cash-up are listed as "Not cashed up".
  function cashupReportRows(from, to){
    var days = {};
    Object.keys(STATE.cashups).forEach(function(d){ if((!from || d>=from) && (!to || d<=to)) days[d] = true; });
    STATE.receipts.forEach(function(r){ if(!r.voided && r.date && (!from || r.date>=from) && (!to || r.date<=to)) days[r.date] = true; });
    return Object.keys(days).sort().map(function(d){
      var c = STATE.cashups[d] || null, recs = receiptsOn(d);
      var cashRec = round2(recs.filter(function(r){ return r.method==='cash'; }).reduce(function(s,r){ return s+Number(r.amount||0); },0));
      var cardRec = round2(recs.filter(function(r){ return r.method==='card'; }).reduce(function(s,r){ return s+Number(r.amount||0); },0));
      if(!c) return {date:d, done:false, receipts:recs.length, cashRec:cashRec, cardRec:cardRec};
      return {date:d, done:true, receipts:recs.length, counted:Number(c.cashCounted)||0, float:Number(c.float)||0, takings:Number(c.cashTakings)||0,
        cashRec:Number(c.cashExpected!=null?c.cashExpected:cashRec)||0, cashDiff:Number(c.cashDifference)||0,
        card:Number(c.cardTotal)||0, cardRec:Number(c.cardExpected!=null?c.cardExpected:cardRec)||0, cardDiff:Number(c.cardDifference)||0,
        totalDiff:Number(c.totalDifference)||0, by:c.closedBy||'', notes:c.notes||'', late:recs.filter(function(r){ return (c.receiptIds||[]).indexOf(r.id)<0; }).length};
    });
  }
  function receiptsInRange(from, to, includeVoid){
    return STATE.receipts.filter(function(r){ return r.date && (includeVoid || !r.voided) && (!from || r.date>=from) && (!to || r.date<=to); })
      .sort(function(a,b){ return String(a.date+a.createdAt).localeCompare(String(b.date+b.createdAt)); });
  }
  function receiptStatus(r){ return r.voided ? 'VOID' : (r.cashupDate ? 'Cashed up' : 'Open'); }
  function receiptsByUser(list){
    var m = {};
    list.forEach(function(r){
      var k = r.receivedBy || 'Unknown';
      var u = m[k] || (m[k] = {name:k, count:0, cash:0, card:0, total:0, voided:0});
      if(r.voided){ u.voided++; return; }
      var a = Number(r.amount)||0; u.count++; u.total += a; if(r.method==='card') u.card += a; else u.cash += a;
    });
    return Object.keys(m).map(function(k){ var u = m[k]; u.cash = round2(u.cash); u.card = round2(u.card); u.total = round2(u.total); return u; })
      .sort(function(a,b){ return b.total - a.total || a.name.localeCompare(b.name); });
  }
  function cashupReportTotals(rows){
    var t = {days:rows.length, done:0, open:0, counted:0, float:0, takings:0, cashRec:0, cashDiff:0, card:0, cardRec:0, cardDiff:0, totalDiff:0, openRec:0};
    rows.forEach(function(r){
      if(r.done){ t.done++; ['counted','float','takings','cashRec','cashDiff','card','cardRec','cardDiff','totalDiff'].forEach(function(k){ t[k] += r[k]; }); }
      else { t.open++; t.openRec += r.cashRec + r.cardRec; }
    });
    Object.keys(t).forEach(function(k){ if(typeof t[k]==='number' && k!=='days' && k!=='done' && k!=='open') t[k] = round2(t[k]); });
    return t;
  }
  function canSeeSalesReports(){ return isOwnerRole() || currentRole()==='designer'; }
  function reportSwitcher(){
    var views = [{k:'commission', l:'Commission'}];
    if(canCashup()) views.push({k:'cashup', l:'Daily cash-up'});
    if(canSeeSalesReports()){ views.push({k:'age', l:'Age analysis'}); views.push({k:'quotes', l:'Quote success'}); }
    if(views.length < 2) return '';
    var v = views.some(function(x){ return x.k===STATE.reportView; }) ? STATE.reportView : 'commission';
    return '<div class="filterbar" style="margin:-6px 0 14px;">' + views.map(function(x){
      return '<button class="chip-toggle '+(v===x.k?'active':'')+'" data-action="report-view" data-view="'+x.k+'">'+x.l+'</button>';
    }).join('') + '</div>';
  }
  function renderCashupReport(range){
    var rows = cashupReportRows(range.from, range.to), t = cashupReportTotals(rows);
    var dcell = function(v){ return '<td class="num">'+(v===0 ? '<span style="color:var(--ink-faint);">0.00</span>' : diffLabel(v))+'</td>'; };
    var body = rows.length ? rows.map(function(r){
      if(!r.done) return '<tr class="cr-open"><td>'+fullDate(r.date)+'</td><td><span class="pay-chip pay-unpaid">Not cashed up</span></td><td class="num">—</td><td class="num">—</td><td class="num">—</td><td class="num">'+money(r.cashRec)+'</td><td class="num">—</td><td class="num">—</td><td class="num">'+money(r.cardRec)+'</td><td class="num">—</td><td class="num">—</td><td></td></tr>';
      return '<tr class="row-btn" data-action="cashup-open-day" data-date="'+r.date+'"><td>'+fullDate(r.date)+'</td><td><span class="pay-chip pay-paid">Cashed up</span>'+(r.late?' <span class="pay-chip pay-part" title="Receipts captured after the cash-up was saved">+'+r.late+' late</span>':'')+'</td>' +
        '<td class="num">'+money(r.counted)+'</td><td class="num">'+money(r.float)+'</td><td class="num">'+money(r.takings)+'</td><td class="num">'+money(r.cashRec)+'</td>'+dcell(r.cashDiff) +
        '<td class="num">'+money(r.card)+'</td><td class="num">'+money(r.cardRec)+'</td>'+dcell(r.cardDiff)+dcell(r.totalDiff)+'<td>'+escapeHtml(r.by)+'</td></tr>' +
        (r.notes ? '<tr class="cr-note"><td></td><td colspan="11">Note: '+escapeHtml(r.notes)+'</td></tr>' : '');
    }).join('') + '<tr class="total-row"><td>Total</td><td>'+t.done+' of '+t.days+' day'+(t.days===1?'':'s')+'</td><td class="num">'+money(t.counted)+'</td><td class="num">'+money(t.float)+'</td><td class="num">'+money(t.takings)+'</td><td class="num">'+money(t.cashRec)+'</td><td class="num">'+money(t.cashDiff)+'</td><td class="num">'+money(t.card)+'</td><td class="num">'+money(t.cardRec)+'</td><td class="num">'+money(t.cardDiff)+'</td><td class="num">'+money(t.totalDiff)+'</td><td></td></tr>'
      : '<tr><td colspan="12" class="empty-note">No receipts or cash-ups in this period.</td></tr>';
    var bar = '<div class="panel" style="padding:12px 14px; margin-bottom:16px;"><div class="period-bar">' +
      reportPresets().map(function(p){ var on = range.from===p.from && range.to===p.to; return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="report-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>'; }).join('') +
      '<span style="flex:1"></span>' +
      '<label for="reportFrom" style="margin:0;">From</label><input type="date" id="reportFrom" value="'+escapeHtml(range.from||'')+'" style="width:auto;">' +
      '<label for="reportTo" style="margin:0;">To</label><input type="date" id="reportTo" value="'+escapeHtml(range.to||'')+'" style="width:auto;">' +
      '</div></div>';
    return '<div class="topline"><div><h1>Reports</h1><div class="sub">Daily cash-up report &middot; '+rangeLabel(range)+'</div></div>' +
        '<div style="display:flex; gap:8px;"><button class="btn btn-sm" data-action="cashrep-xlsx"'+(rows.length?'':' disabled')+'>Download Excel</button><button class="btn btn-primary btn-sm" data-action="cashrep-pdf"'+(rows.length?'':' disabled')+'>Download PDF</button></div></div>' +
      reportSwitcher() + bar +
      '<div class="tiles">' +
        tile('Cash takings', money(t.takings), 'After the float, '+t.done+' day'+(t.done===1?'':'s')+' cashed up') +
        tile('Card', money(t.card), 'Card machine totals') +
        tile('Over / short', (t.totalDiff===0?'R 0.00':diffLabel(t.totalDiff)), 'Counted vs receipts') +
        tile('Not cashed up', String(t.open), t.open ? (money(t.openRec)+' in receipts') : 'Every day is done') +
      '</div>' +
      '<div class="panel"><div class="tbl-wrap"><table class="cashrep-table"><thead><tr><th>Day</th><th>Status</th><th class="num">Cash counted</th><th class="num">Float</th><th class="num">Cash takings</th><th class="num">Cash receipts</th><th class="num">Cash diff.</th><th class="num">Card machine</th><th class="num">Card receipts</th><th class="num">Card diff.</th><th class="num">Total diff.</th><th>Cashed up by</th></tr></thead><tbody>'+body+'</tbody></table></div>' +
      '<div class="hint" style="margin-top:8px;">Click a day to open its cash-up. Cash takings = cash counted less the float.</div></div>' +
      renderReceiptsIssued(range);
  }
  function renderReceiptsIssued(range){
    var list = receiptsInRange(range.from, range.to, true), users = receiptsByUser(list);
    if(!list.length) return '';
    var rows = list.map(function(r){
      var st = receiptStatus(r);
      return '<tr class="'+(r.voided?'cr-void':'')+'"><td>'+fullDate(r.date)+'</td><td class="mono">'+escapeHtml(String(r.createdAt||'').slice(11,16))+'</td><td class="mono">'+escapeHtml(r.number||'')+'</td><td>'+escapeHtml(r.customerName||'')+'</td>' +
        '<td class="mono">'+escapeHtml(r.jobNumber||'')+'</td><td class="mono">'+escapeHtml(r.invoiceNumber||'')+'</td><td>'+(r.method==='card'?'Card':'Cash')+'</td><td>'+(r.kind==='prepayment'?'Deposit':'Payment')+'</td>' +
        '<td class="num">'+money(r.amount)+'</td><td><strong>'+escapeHtml(r.receivedBy||'—')+'</strong></td>' +
        '<td>'+(r.voided ? '<span class="pay-chip pay-unpaid" title="'+escapeHtml(r.voidReason||'')+'">Void</span>'+(r.voidReason?' <span class="cr-reason">'+escapeHtml(r.voidReason)+'</span>':'') : (r.cashupDate ? '<span class="pay-chip pay-paid">Cashed up</span>' : '<span class="pay-chip pay-part">Open</span>'))+'</td></tr>';
    }).join('');
    var valid = list.filter(function(r){ return !r.voided; });
    var tot = round2(valid.reduce(function(s,r){ return s+(Number(r.amount)||0); },0));
    var urows = users.map(function(u){ return '<tr><td><strong>'+escapeHtml(u.name)+'</strong></td><td class="num">'+u.count+'</td><td class="num">'+money(u.cash)+'</td><td class="num">'+money(u.card)+'</td><td class="num"><strong>'+money(u.total)+'</strong></td><td class="num">'+(u.voided||'')+'</td></tr>'; }).join('');
    return '<div class="panel"><div class="panel-head"><h2>Receipts issued</h2><span class="hint" style="margin:0;">'+valid.length+' receipt'+(valid.length===1?'':'s')+' &middot; '+money(tot)+(list.length>valid.length?(' &middot; '+(list.length-valid.length)+' voided'):'')+'</span></div>' +
      '<div class="section-label">By user</div>' +
      '<div class="tbl-wrap" style="margin-bottom:14px;"><table class="cashrep-table"><thead><tr><th>Issued by</th><th class="num">Receipts</th><th class="num">Cash</th><th class="num">Card</th><th class="num">Total</th><th class="num">Voided</th></tr></thead><tbody>'+urows+'</tbody></table></div>' +
      '<div class="section-label">All receipts</div>' +
      '<div class="tbl-wrap"><table class="cashrep-table"><thead><tr><th>Date</th><th>Time</th><th>Receipt</th><th>Customer</th><th>Job</th><th>Invoice</th><th>Method</th><th>Type</th><th class="num">Amount</th><th>Issued by</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
      '<div class="hint" style="margin-top:8px;">Voided receipts are listed for the record but not counted in any totals.</div></div>';
  }

  /* ---- PDF (A4 landscape) ---- */
  function cashupReportPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return; }
    var range = reportRange(), rows = cashupReportRows(range.from, range.to), t = cashupReportTotals(rows);
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4', orientation:'landscape'});
    var L = 12, R = 285, MAROON = [78,9,40];
    var cols = [['DAY',L+1,'l'],['STATUS',L+31,'l'],['COUNTED',L+90,'r'],['FLOAT',L+109,'r'],['TAKINGS',L+131,'r'],['CASH REC.',L+153,'r'],['CASH DIFF',L+173,'r'],['CARD',L+195,'r'],['CARD REC.',L+217,'r'],['CARD DIFF',L+237,'r'],['TOTAL DIFF',L+258,'r'],['BY',L+261,'l']];
    var curCols = cols, sectionLabel = '';
    var header = function(){
      try { doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 8, 36, 36*(358/800)); } catch(e){}
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(lh('docCompanyName'), R, 13, {align:'right'});
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(95,99,88); doc.text(lh('docAddress'), R, 17.5, {align:'right'});
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 26, R-L, 0.7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text('DAILY CASH-UP REPORT', L, 35);
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(60,60,60); doc.text(rangeLabel(range)+'   ·   Generated '+fullDate(todayIso()), L, 40.5);
      var y = 45;
      if(sectionLabel){ doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(sectionLabel, L, y+3); y += 6; }
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, R-L, 7.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(255,255,255);
      curCols.forEach(function(c){ doc.text(c[0], c[1], y+5, c[2]==='r'?{align:'right'}:{}); });
      return y + 7.5;
    };
    var num = function(v){ return pdfNum(v); };
    var y = header();
    rows.forEach(function(r, i){
      var h = r.notes ? 11 : 7;
      if(y + h > 190){ doc.addPage(); y = header(); }
      if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, h, 'F'); }
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(43,43,43);
      var v = r.done ? [fullDate(r.date), 'Cashed up'+(r.late?(' (+'+r.late+' late)'):''), num(r.counted), num(r.float), num(r.takings), num(r.cashRec), num(r.cashDiff), num(r.card), num(r.cardRec), num(r.cardDiff), num(r.totalDiff), r.by]
                     : [fullDate(r.date), 'NOT CASHED UP', '—', '—', '—', num(r.cashRec), '—', '—', num(r.cardRec), '—', '—', ''];
      v.forEach(function(val, k){
        var neg = r.done && (k===6||k===9||k===10) && Number(String(val).replace(/[^0-9.\-]/g,''))!==0;
        if(neg){ var n = [r.cashDiff, r.cardDiff, r.totalDiff][k===6?0:(k===9?1:2)]; doc.setTextColor(n<0?150:30, n<0?30:107, n<0?30:52); doc.setFont('helvetica','bold'); }
        if(!r.done && k===1){ doc.setTextColor(150,30,30); doc.setFont('helvetica','bold'); }
        doc.text(String(val), cols[k][1], y+4.8, cols[k][2]==='r'?{align:'right'}:{});
        doc.setTextColor(43,43,43); doc.setFont('helvetica','normal');
      });
      if(r.notes){ doc.setFont('helvetica','italic'); doc.setFontSize(7.5); doc.setTextColor(95,99,88); doc.text(doc.splitTextToSize('Note: '+r.notes, R-L-34)[0], cols[1][1], y+9); }
      y += h;
    });
    if(y + 9 > 190){ doc.addPage(); y = header(); }
    doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.4); doc.line(L, y+0.5, R, y+0.5);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.2); doc.setTextColor(43,43,43);
    var tv = ['TOTAL', t.done+' of '+t.days+' days cashed up', num(t.counted), num(t.float), num(t.takings), num(t.cashRec), num(t.cashDiff), num(t.card), num(t.cardRec), num(t.cardDiff), num(t.totalDiff), ''];
    tv.forEach(function(val, k){ doc.text(String(val), cols[k][1], y+5.5, cols[k][2]==='r'?{align:'right'}:{}); });
    y += 13;
    if(t.open){ if(y > 185){ doc.addPage(); y = header(); } doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(150,30,30); doc.text(t.open+' day'+(t.open===1?' has':'s have')+' receipts ('+money(t.openRec)+') but no saved cash-up.', L, y); y += 6; }
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(95,99,88);
    doc.text('Cash takings = cash counted less the float. Differences: positive = over, negative = short. Amounts in '+(STATE.config.currency||'ZAR')+'.', L, Math.min(y, 192));

    /* receipts issued: by user, then every receipt */
    var rlist = receiptsInRange(range.from, range.to, true);
    if(rlist.length){
      var users = receiptsByUser(rlist);
      curCols = [['ISSUED BY',L+1,'l'],['RECEIPTS',L+80,'r'],['CASH',L+115,'r'],['CARD',L+150,'r'],['TOTAL',L+185,'r'],['VOIDED',L+210,'r']];
      sectionLabel = 'RECEIPTS ISSUED — BY USER';
      doc.addPage(); y = header();
      users.forEach(function(u, i){
        if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, 7, 'F'); }
        doc.setFont('helvetica','normal'); doc.setFontSize(8.5); doc.setTextColor(43,43,43);
        [u.name, String(u.count), num(u.cash), num(u.card), num(u.total), u.voided?String(u.voided):''].forEach(function(v, k){ if(k===0||k===4) doc.setFont('helvetica','bold'); doc.text(v, curCols[k][1], y+4.8, curCols[k][2]==='r'?{align:'right'}:{}); doc.setFont('helvetica','normal'); });
        y += 7;
      });
      y += 8;
      curCols = [['DATE',L+1,'l'],['TIME',L+25,'l'],['RECEIPT',L+38,'l'],['CUSTOMER',L+62,'l'],['JOB',L+118,'l'],['INVOICE',L+140,'l'],['METHOD',L+165,'l'],['TYPE',L+181,'l'],['AMOUNT',L+218,'r'],['ISSUED BY',L+222,'l'],['STATUS',L+252,'l']];
      sectionLabel = 'RECEIPTS ISSUED — ALL RECEIPTS';
      var tableTop = function(){
        doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(sectionLabel, L, y+3); y += 6;
        doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, R-L, 7.5, 'F');
        doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(255,255,255);
        curCols.forEach(function(c){ doc.text(c[0], c[1], y+5, c[2]==='r'?{align:'right'}:{}); });
        y += 7.5;
      };
      if(y + 30 > 190){ doc.addPage(); y = header(); } else tableTop();
      rlist.forEach(function(r, i){
        var rh = (r.voided && r.voidReason) ? 10.5 : 7;
        if(y + rh > 192){ doc.addPage(); y = header(); }
        if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, rh, 'F'); }
        doc.setFont('helvetica','normal'); doc.setFontSize(7.8); doc.setTextColor(r.voided?150:43, r.voided?150:43, r.voided?140:43);
        var v = [fullDate(r.date), String(r.createdAt||'').slice(11,16), r.number||'', doc.splitTextToSize(String(r.customerName||''), 54)[0], r.jobNumber||'', r.invoiceNumber||'', r.method==='card'?'Card':'Cash', r.kind==='prepayment'?'Deposit':'Payment', num(r.amount), r.receivedBy||'', r.voided ? 'VOID' : (r.cashupDate?'Cashed up':'Open')];
        v.forEach(function(val, k){
          if(k===9) doc.setFont('helvetica','bold');
          if(k===10 && r.voided){ doc.setTextColor(150,30,30); doc.setFont('helvetica','bold'); }
          doc.text(String(val), curCols[k][1], y+4.8, curCols[k][2]==='r'?{align:'right'}:{});
          doc.setFont('helvetica','normal');
        });
        if(r.voided && r.voidReason){ doc.setFont('helvetica','italic'); doc.setFontSize(7.2); doc.setTextColor(150,30,30); doc.text(doc.splitTextToSize('Void reason: '+r.voidReason, R-curCols[3][1]-4)[0], curCols[3][1], y+8.6); doc.setFont('helvetica','normal'); }
        y += rh;
      });
      var valid = rlist.filter(function(r){ return !r.voided; });
      if(y + 9 > 192){ doc.addPage(); y = header(); }
      doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.4); doc.line(L, y+0.5, R, y+0.5);
      doc.setFont('helvetica','bold'); doc.setFontSize(8.2); doc.setTextColor(43,43,43);
      doc.text(valid.length+' receipts (voided receipts not counted)', L+1, y+5.5);
      doc.text(num(valid.reduce(function(s,r){ return s+(Number(r.amount)||0); },0)), curCols[8][1], y+5.5, {align:'right'});
    }
    var n = doc.getNumberOfPages();
    for(var i=1;i<=n;i++){ doc.setPage(i); doc.setFontSize(7.5); doc.setTextColor(140,140,132); doc.text('Page '+i+' of '+n, R, 203, {align:'right'}); }
    var name = 'DsignX-cash-up-report-'+(range.from||'start')+'-to-'+(range.to||todayIso())+'.pdf';
    var blob = doc.output('blob');
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* ---- Excel (.xlsx) — written directly, no add-on needed ---- */
  var _crcTable = null;
  function crc32(bytes){
    if(!_crcTable){ _crcTable = []; for(var n=0;n<256;n++){ var c=n; for(var k=0;k<8;k++) c = (c&1) ? (0xEDB88320 ^ (c>>>1)) : (c>>>1); _crcTable[n] = c>>>0; } }
    var crc = 0xFFFFFFFF; for(var i=0;i<bytes.length;i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc>>>8); return (crc ^ 0xFFFFFFFF)>>>0;
  }
  function zipStore(files){ // files: [{name, data:Uint8Array}] — stored (no compression), valid for Excel
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    var u16 = function(v){ return [v&255, (v>>>8)&255]; }, u32 = function(v){ return [v&255, (v>>>8)&255, (v>>>16)&255, (v>>>24)&255]; };
    files.forEach(function(f){
      var nm = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      var head = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(sz), u32(sz), u16(nm.length), u16(0));
      parts.push(new Uint8Array(head), nm, f.data);
      central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(sz), u32(sz), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)), nm);
      offset += head.length + nm.length + sz;
    });
    var cdStart = offset, cdSize = 0, cparts = [];
    central.forEach(function(c){ if(Array.isArray(c)){ var a = new Uint8Array(c); cparts.push(a); cdSize += a.length; } else { cparts.push(c); cdSize += c.length; } });
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(cdStart), u16(0)));
    return new Blob(parts.concat(cparts, [end]), {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  }
  function xmlEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  function colName(i){ var s = ''; i++; while(i>0){ var m = (i-1)%26; s = String.fromCharCode(65+m) + s; i = Math.floor((i-1)/26); } return s; }
  // sheet: {name, widths:[..], rows:[[cell]]}; cell = string | number | {v, s} with s: 1 bold, 2 money, 3 bold money, 4 header, 5 red money
  function sheetXml(sh){
    var rows = sh.rows.map(function(row, ri){
      return '<row r="'+(ri+1)+'">' + row.map(function(cell, ci){
        if(cell===null || cell===undefined || cell==='') return '';
        var v = (typeof cell==='object') ? cell.v : cell, st = (typeof cell==='object' && cell.s) ? cell.s : (typeof v==='number' ? 2 : 0);
        var ref = colName(ci)+(ri+1);
        if(typeof v==='number') return '<c r="'+ref+'" s="'+st+'"><v>'+v+'</v></c>';
        return '<c r="'+ref+'" s="'+st+'" t="inlineStr"><is><t xml:space="preserve">'+xmlEsc(v)+'</t></is></c>';
      }).join('') + '</row>';
    }).join('');
    var cols = (sh.widths||[]).map(function(w, i){ return '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+w+'" customWidth="1"/>'; }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="'+(sh.freeze||1)+'" topLeftCell="A'+((sh.freeze||1)+1)+'" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      (cols ? '<cols>'+cols+'</cols>' : '') + '<sheetData>'+rows+'</sheetData></worksheet>';
  }
  function buildXlsx(sheets){
    var enc = new TextEncoder(), f = function(name, xml){ return {name:name, data:enc.encode(xml)}; };
    var files = [
      f('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheets.map(function(s, i){ return '<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>'),
      f('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      f('xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        sheets.map(function(s, i){ return '<sheet name="'+xmlEsc(s.name).slice(0,31)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>'; }).join('') + '</sheets></workbook>'),
      f('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        sheets.map(function(s, i){ return '<Relationship Id="rId'+(i+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>'; }).join('') +
        '<Relationship Id="rId'+(sheets.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
      f('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;R&quot;\\ #,##0.00;[Red]\\-&quot;R&quot;\\ #,##0.00"/></numFmts>' +
        '<fonts count="3"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF4E0928"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
    ];
    sheets.forEach(function(s, i){ files.push(f('xl/worksheets/sheet'+(i+1)+'.xml', sheetXml(s))); });
    return zipStore(files);
  }
  function cashupReportXlsx(){
    var range = reportRange(), rows = cashupReportRows(range.from, range.to), t = cashupReportTotals(rows);
    var H = function(x){ return {v:x, s:4}; };
    var days = [[H('Day'),H('Status'),H('Cash counted'),H('Float'),H('Cash takings'),H('Cash receipts'),H('Cash difference'),H('Card machine'),H('Card receipts'),H('Card difference'),H('Total difference'),H('Cashed up by'),H('Notes')]];
    rows.forEach(function(r){
      days.push(r.done ? [r.date, 'Cashed up'+(r.late?(' (+'+r.late+' late receipts)'):''), r.counted, r.float, r.takings, r.cashRec, r.cashDiff, r.card, r.cardRec, r.cardDiff, r.totalDiff, r.by, r.notes]
                       : [r.date, 'Not cashed up', '', '', '', r.cashRec, '', '', r.cardRec, '', '', '', '']);
    });
    var B = function(v){ return {v:v, s:3}; };
    days.push([]);
    days.push([{v:'Total', s:1}, {v:t.done+' of '+t.days+' days cashed up', s:1}, B(t.counted), B(t.float), B(t.takings), B(t.cashRec), B(t.cashDiff), B(t.card), B(t.cardRec), B(t.cardDiff), B(t.totalDiff)]);
    var recs = [[H('Date'),H('Time'),H('Receipt'),H('Customer'),H('Job'),H('Invoice'),H('Method'),H('Type'),H('Amount'),H('Issued by'),H('Status'),H('Void reason'),H('Note')]];
    var rlist = receiptsInRange(range.from, range.to, true);
    rlist.forEach(function(r){ recs.push([r.date, String(r.createdAt||'').slice(11,16), r.number, r.customerName||'', r.jobNumber||'', r.invoiceNumber||'', r.method==='card'?'Card':'Cash', r.kind==='prepayment'?'Deposit':'Payment', Number(r.amount)||0, r.receivedBy||'', receiptStatus(r), r.voided?(r.voidReason||''):'', r.note||'']); });
    var validR = rlist.filter(function(r){ return !r.voided; });
    recs.push([]); recs.push([{v:'Total (excl. voided)', s:1}, '', {v:validR.length+' receipts', s:1}, '', '', '', '', '', B(round2(validR.reduce(function(s,r){ return s+(Number(r.amount)||0); },0)))]);
    var byUser = [[H('Issued by'),H('Receipts'),H('Cash'),H('Card'),H('Total'),H('Voided')]];
    receiptsByUser(rlist).forEach(function(u){ byUser.push([{v:u.name, s:1}, u.count, u.cash, u.card, B(u.total), u.voided]); });
    byUser.forEach(function(row, i){ if(i>0) row[1] = {v:row[1], s:0}; if(i>0) row[5] = {v:row[5], s:0}; });
    var blob = buildXlsx([
      {name:'Daily cash-ups', widths:[12,26,14,10,14,14,15,14,14,15,15,16,40], rows:days},
      {name:'Receipts', widths:[12,7,13,28,12,14,8,10,13,18,11,26,30], rows:recs},
      {name:'Receipts by user', widths:[22,10,14,14,14,9], rows:byUser}
    ]);
    var name = 'DsignX-cash-up-report-'+(range.from||'start')+'-to-'+(range.to||todayIso())+'.xlsx';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }
  /* ============================ credit notes ============================ */
  // Only the owner issues credit notes, and only against an invoice that still has a balance owing.
  // A credit note reduces what the customer owes on that invoice (and the sale value used for commission).
  function orderCredits(orderId){
    return (STATE.creditNotes||[]).filter(function(c){ return c.orderId===orderId && !c.voided; })
      .sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); });
  }
  function orderCredited(orderId){ return round2(orderCredits(orderId).reduce(function(s,c){ return s + (Number(c.total)||0); }, 0)); }
  function orderCreditedExVat(orderId){ return round2(orderCredits(orderId).reduce(function(s,c){ return s + (Number(c.subtotal)||0); }, 0)); }
  function invoiceGross(o){
    if(hasInvoiceDoc(o)) return round2(invoiceTotals({items:o.invoiceLineItems, vatEnabled:!!o.invoiceVatEnabled && isVatVendor()}).total);
    if((o.lineItems||[]).length) return round2(quoteTotals({items:o.lineItems, vatEnabled:!!o.quoteVatEnabled && isVatVendor()}).total);
    return round2(Number(o.quoteAmount)||0);
  }
  function canIssueCredit(o){ return isOwnerRole() && !!o && hasInvoiceDoc(o) && payStatus(o).balance > 0.004; }
  function cnTotals(f){
    var items = (f.items||[]).filter(function(li){ return String(li.description||'').trim() || lineNet(li); });
    var sub = round2(items.reduce(function(s,li){ return s + lineNet(li); }, 0));
    var vat = f.vatOn ? round2(sub * (Number(STATE.config.vatRate)||0) / 100) : 0;
    // "Credit the full outstanding balance": VAT absorbs the 1c rounding so the total is exactly the balance.
    if(f.vatOn && f.fullEx!=null && items.length===1 && round2(items[0].unitPrice)===f.fullEx && Number(items[0].qty)===1 && !lineDiscPct(items[0])) vat = round2(f.balance - sub);
    return {items:items, subtotal:sub, vat:vat, total:round2(sub+vat), discount:linesDiscount(items)};
  }
  function openCreditForm(orderId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; });
    if(!isOwnerRole()){ toast('Only the owner can issue credit notes'); return; }
    if(!o || !hasInvoiceDoc(o)){ toast('Generate the invoice first'); return; }
    var st = payStatus(o);
    if(!(st.balance > 0.004)){ toast('This invoice has nothing outstanding to credit'); return; }
    STATE.creditForm = {
      orderId:orderId, vatOn:!!o.invoiceVatEnabled && isVatVendor(), balance:st.balance,
      items:(o.invoiceLineItems||[]).map(function(li){ return {description:li.description||'', qty:Number(li.qty)||0, unitPrice:Number(li.unitPrice)||0, discount:lineDiscPct(li)||''}; }),
      reason:'', date:todayIso(), error:'', busy:false, saved:null
    };
    // Something already paid or credited: start from one line for the outstanding balance instead.
    if(st.balance < invoiceGross(o) - 0.004){ creditFullBalance(); return; }
    render();
  }
  // Replace the lines with one line that credits the whole outstanding balance.
  function creditFullBalance(){
    var f = STATE.creditForm; if(!f) return;
    var o = STATE.orders.find(function(x){ return x.id===f.orderId; }); if(!o) return;
    var rate = f.vatOn ? (Number(STATE.config.vatRate)||0)/100 : 0;
    var ex = round2(f.balance / (1 + rate));
    f.fullEx = ex;
    f.items = [{description:'Credit on invoice '+(o.invoiceNumber||''), qty:1, unitPrice:ex, discount:''}];
    render();
  }
  function renderCreditModal(){
    var f = STATE.creditForm; if(!f) return '';
    var o = STATE.orders.find(function(x){ return x.id===f.orderId; }); if(!o) return '';
    if(f.saved){
      var c = f.saved;
      return '<div class="overlay" data-action="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Credit note issued" style="max-width:480px;">' +
        '<div class="modal-head"><div><div class="jobno mono">'+escapeHtml(c.number)+'</div><h2>Credit note issued</h2></div><button class="modal-close" data-action="cn-close" aria-label="Close">&times;</button></div>' +
        '<p style="margin-top:0;">'+money(c.total)+' credited on invoice '+escapeHtml(c.invoiceNumber)+' for '+escapeHtml(c.customerName)+'.<br><span class="hint">Reason: '+escapeHtml(c.reason)+'</span></p>' +
        '<div class="modal-foot">' +
          '<button class="btn btn-ghost" data-action="cn-close">Done</button>' +
          '<button class="btn" data-action="cn-pdf" data-id="'+c.id+'">Download PDF</button>' +
          (waPhone(c.phone) && STATE.mcp ? '<button class="btn btn-primary" data-action="cn-wa" data-id="'+c.id+'">Send via WhatsApp</button>' : '') +
        '</div></div></div>';
    }
    var t = cnTotals(f);
    var rows = f.items.map(function(li, i){
      return '<tr>' +
        '<td style="min-width:180px;"><input type="text" data-cnf="description" data-i="'+i+'" value="'+escapeHtml(li.description)+'"></td>' +
        '<td style="width:64px;"><input type="number" min="0" step="1" data-cnf="qty" data-i="'+i+'" value="'+escapeHtml(String(li.qty))+'"></td>' +
        '<td style="width:100px;"><input type="number" min="0" step="0.01" data-cnf="unitPrice" data-i="'+i+'" value="'+escapeHtml(String(li.unitPrice))+'"></td>' +
        '<td style="width:74px;"><input type="number" min="0" max="100" step="0.01" placeholder="0" data-cnf="discount" data-i="'+i+'" value="'+escapeHtml(String(li.discount||''))+'"></td>' +
        '<td class="num" id="cnLine-'+i+'" style="white-space:nowrap;">'+money(lineNet(li))+'</td>' +
        '<td><button class="btn btn-ghost btn-sm" data-action="cn-remove-line" data-i="'+i+'" title="Remove line">&times;</button></td>' +
      '</tr>';
    }).join('');
    var over = t.total > f.balance + 0.004;
    return '<div class="overlay" data-action="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="Issue credit note" style="max-width:680px;">' +
      '<div class="modal-head"><div><div class="jobno mono">Invoice '+escapeHtml(o.invoiceNumber||'')+'</div><h2>Credit note for '+escapeHtml(o.customerName||'')+'</h2></div><button class="modal-close" data-action="cn-close" aria-label="Close">&times;</button></div>' +
      '<p class="hint" style="margin-top:0;">Invoice total '+money(invoiceGross(o))+' &middot; outstanding <strong>'+money(f.balance)+'</strong>. The credit note can’t be more than what is outstanding. Edit, remove or add lines for what you are crediting.</p>' +
      (f.error ? '<div class="field-error" style="margin-bottom:8px;">'+escapeHtml(f.error)+'</div>' : '') +
      '<div class="tbl-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Disc %</th><th>Line total</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 14px;">' +
        '<button class="btn btn-ghost btn-sm" data-action="cn-add-line">+ Add line</button>' +
        '<button class="btn btn-ghost btn-sm" data-action="cn-full">Credit the full outstanding balance</button>' +
      '</div>' +
      '<div class="kv" style="justify-content:flex-end; margin-left:auto; max-width:280px; margin-bottom:14px;">' +
        '<dt>Subtotal</dt><dd class="num" id="cnSub">'+money(t.subtotal)+'</dd>' +
        (f.vatOn ? '<dt>VAT ('+(STATE.config.vatRate||15)+'%)</dt><dd class="num" id="cnVat">'+money(t.vat)+'</dd>' : '') +
        '<dt style="font-weight:700; color:var(--ink);">Credit note total</dt><dd class="num" id="cnTotal" style="font-weight:700;'+(over?' color:#a12222;':'')+'">'+money(t.total)+'</dd>' +
      '</div>' +
      '<div class="field"><label for="cnReason">Reason for the credit note <span style="color:#a12222;">*</span></label><textarea id="cnReason" data-cnr="reason" rows="2" placeholder="e.g. Banner reprinted at our cost — colour mismatch">'+escapeHtml(f.reason)+'</textarea><div class="hint">Printed on the credit note.</div></div>' +
      '<div class="field"><label for="cnDate">Credit note date</label><input type="date" id="cnDate" data-cnr="date" style="max-width:200px;" value="'+escapeHtml(f.date)+'"></div>' +
      '<div class="modal-foot"><button class="btn btn-ghost" data-action="cn-close">Cancel</button><button class="btn btn-primary" data-action="cn-save"'+(f.busy?' disabled':'')+'>'+(f.busy?'Saving…':'Issue credit note')+'</button></div>' +
    '</div></div>';
  }
  function onCreditInput(el){
    var f = STATE.creditForm; if(!f) return;
    var r = el.getAttribute('data-cnr');
    if(r){ f[r] = el.value; return; }
    var k = el.getAttribute('data-cnf'), i = Number(el.getAttribute('data-i'));
    if(!k || !f.items[i]) return;
    f.items[i][k] = k==='description' ? el.value : el.value;
    var cell = document.getElementById('cnLine-'+i); if(cell) cell.innerHTML = money(lineNet(f.items[i]));
    var t = cnTotals(f);
    var s = document.getElementById('cnSub'); if(s) s.innerHTML = money(t.subtotal);
    var v = document.getElementById('cnVat'); if(v) v.innerHTML = money(t.vat);
    var tt = document.getElementById('cnTotal'); if(tt){ tt.innerHTML = money(t.total); tt.style.color = t.total > f.balance + 0.004 ? '#a12222' : ''; }
  }
  function saveCreditNote(){
    var f = STATE.creditForm; if(!f || f.busy) return;
    if(!isOwnerRole()){ f.error = 'Only the owner can issue credit notes.'; render(); return; }
    var o = STATE.orders.find(function(x){ return x.id===f.orderId; }); if(!o) return;
    var t = cnTotals(f);
    var reason = String(f.reason||'').trim();
    var bal = payStatus(o).balance;
    if(!t.items.length || !(t.total > 0)){ f.error = 'Add at least one line with an amount to credit.'; render(); return; }
    if(t.items.some(function(li){ return !String(li.description||'').trim(); })){ f.error = 'Every line needs a description.'; render(); return; }
    if(t.total > bal + 0.004){ f.error = 'The credit note ('+money(t.total)+') is more than the outstanding balance ('+money(bal)+').'; render(); return; }
    if(!reason){ f.error = 'Enter the reason for the credit note.'; render(); return; }
    if(!f.date){ f.error = 'Choose the credit note date.'; render(); return; }
    f.busy = true; f.error = ''; render();
    var member = currentTeamMember();
    reserveNumbers('nextCreditNoteNumber', 1).then(function(n){
      var rec = {
        number:'DSX-CN'+pad4(n), date:f.date, createdAt:new Date().toISOString(),
        orderId:o.id, invoiceNumber:o.invoiceNumber||'', jobNumber:o.jobNumber||jobNo(o.id), jobTitle:o.title||'', poNumber:o.poNumber||'',
        customerId:o.customerId||null, customerName:o.customerName||'', phone:o.phone||'',
        reason:reason, vatEnabled:!!f.vatOn, vatRate:Number(STATE.config.vatRate)||0,
        items:t.items.map(function(li){ var x = {description:String(li.description).trim(), qty:Number(li.qty)||0, unitPrice:round2(li.unitPrice)}; if(lineDiscPct(li)) x.discount = lineDiscPct(li); return x; }),
        subtotal:t.subtotal, vat:t.vat, total:t.total, discountTotal:t.discount,
        designerName:o.designerName||'', technicianName:o.technicianName||'', technician2Name:o.technician2Name||'',
        issuedBy: member ? member.name : 'Owner', voided:false
      };
      if(STATE.isLive && STATE.db){
        return STATE.db.collection('creditNotes').add(rec).then(function(ref){ return Object.assign({id:ref.id}, rec); });
      }
      var c = Object.assign({id:uid()}, rec); STATE.creditNotes.push(c); return c;
    }).then(function(c){
      f.busy = false; f.saved = c;
      if(!(STATE.creditNotes||[]).some(function(x){ return x.id===c.id; })) STATE.creditNotes.push(c);
      render();
      toast('Credit note '+c.number+' issued');
    }).catch(function(){ f.busy = false; f.error = 'Couldn’t save — check your connection and try again.'; render(); });
  }
  function voidCreditNote(id){
    var c = (STATE.creditNotes||[]).find(function(x){ return x.id===id; }); if(!c || !isOwnerRole()) return;
    var why = prompt('Void credit note '+c.number+'? The invoice balance goes back up. Type a reason (it stays on record, marked VOID):');
    if(why===null) return;
    var patch = {voided:true, voidReason:String(why||'').trim() || 'Voided', voidedAt:new Date().toISOString()};
    if(STATE.isLive && STATE.db){ STATE.db.doc('creditNotes/'+id).update(patch).catch(function(){ toast('Could not void — try again'); }); }
    else { Object.assign(c, patch); render(); }
  }
  function renderCreditRows(o){
    var list = (STATE.creditNotes||[]).filter(function(c){ return c.orderId===o.id; }).sort(function(a,b){ return String(a.createdAt).localeCompare(String(b.createdAt)); });
    return list.map(function(c){
      return '<div class="pay-row'+(c.voided?' voided':'')+'"><span class="mono">'+escapeHtml(c.number)+'</span><span>'+shortDate(c.date)+'</span><span title="'+escapeHtml(c.reason||'')+'">Credit note</span><span class="num">−'+money(c.total)+'</span>' +
        '<span class="pay-actions">' + (c.voided ? '<em>VOID</em>' :
          '<button class="btn btn-ghost btn-sm" data-action="cn-pdf" data-id="'+c.id+'">PDF</button>' +
          (waPhone(c.phone) && STATE.mcp ? '<button class="btn btn-ghost btn-sm" data-action="cn-wa" data-id="'+c.id+'">WhatsApp</button>' : '') +
          (isOwnerRole() ? '<button class="btn btn-ghost btn-sm" data-action="cn-void" data-id="'+c.id+'">Void</button>' : '')) +
        '</span></div>' +
        (c.reason && !c.voided ? '<div class="hint" style="margin:-2px 0 4px 2px;">Reason: '+escapeHtml(c.reason)+'</div>' : '');
    }).join('');
  }

  function creditNotePdf(c){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return null; }
    var cfg = STATE.config;
    var o = STATE.orders.find(function(x){ return x.id===c.orderId; }) || {};
    var cust = STATE.customers.find(function(x){ return x.id===(c.customerId||o.customerId); }) || {};
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195, W = R - L;
    var MAROON = [78,9,40], INK = [43,43,43], GREY = [95,99,88], SAGE = [121,128,110], PANEL = [244,245,242], RULE = [222,222,216];
    function color(x){ doc.setTextColor(x[0],x[1],x[2]); }
    function font(style, size){ doc.setFont('helvetica', style); doc.setFontSize(size); }
    function spaced(txt, x, y, opts, cs){ doc.setCharSpace(cs==null?0.6:cs); doc.text(txt, x, y, opts||{}); doc.setCharSpace(0); }
    var vatNo = String(cfg.businessVatNumber||'').trim();
    var vatOn = !!c.vatEnabled;
    var rate = Number(c.vatRate)||Number(cfg.vatRate)||15;
    var currency = cfg.currency || 'ZAR';
    var items = c.items || [];
    function footer(){
      doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.25); doc.line(L, 277, R, 277);
      font('bold', 8.5); color(MAROON); doc.text('Thank you for your business!', 105, 281.5, {align:'center'});
      font('normal', 6.8); color(GREY);
      var biz = /\(PTY\)\s*LTD/i.test(lh('docCompanyName')) ? ((cfg.businessName||'DsignX')+' (Pty) Ltd') : lh('docCompanyName');
      doc.text([biz, 'Reg No '+lh('docRegNo')].concat(vatNo ? ['VAT No '+vatNo] : []).concat([lh('docAddress')]).join('  ·  '), 105, 285, {align:'center'});
      doc.text(['Tel '+lh('docTel'), 'WhatsApp '+lh('docWhatsapp'), lh('docEmail'), lh('docWebsite')].join('  ·  '), 105, 288.3, {align:'center'});
    }
    /* letterhead */
    var logoW = 56, logoH = logoW * (358/800);
    doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 12, logoW, logoH);
    font('bold', 11.5); color(MAROON); spaced(lh('docCompanyName'), R, 18.5, {align:'right'}, 0.12);
    font('normal', 8.3); color(GREY);
    doc.text(lh('docAddress'), R, 23, {align:'right'});
    doc.text('Tel '+lh('docTel')+'   |   WhatsApp '+lh('docWhatsapp'), R, 27.2, {align:'right'});
    doc.text(lh('docEmail')+'   |   '+lh('docWebsite'), R, 31.4, {align:'right'});
    var parts = [['Reg No ', lh('docRegNo')]].concat(vatNo ? [['   |   ',''],['VAT No ', vatNo]] : []);
    var widths = parts.map(function(p){ font('bold', 8.3); var a = doc.getTextWidth(p[0]); font('normal', 8.3); return a + doc.getTextWidth(p[1]); });
    var x = R - widths.reduce(function(a,b){ return a+b; }, 0);
    parts.forEach(function(p){
      var isSep = p[0].trim()==='|';
      font(isSep ? 'normal' : 'bold', 8.3); color(GREY); doc.text(p[0], x, 35.6); x += doc.getTextWidth(p[0]);
      font('normal', 8.3); doc.text(p[1], x, 35.6); x += doc.getTextWidth(p[1]);
    });
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 40.5, W, 0.9, 'F');
    /* title + customer */
    font('bold', 25); color(MAROON); spaced(c.voided ? 'CREDIT NOTE — VOID' : 'CREDIT NOTE', L, 55, null, 0.35);
    font('bold', 7.2); color(SAGE); spaced('CUSTOMER', L, 62, null, 0.6);
    font('bold', 10.5); color(INK); doc.text(c.customerName || cust.name || 'Customer', L, 67.5);
    font('normal', 8.8); color(GREY);
    var cy = 72, lines = [];
    if(addrHasData(cust.postalAddress)) lines = lines.concat(formatAddress(cust.postalAddress).split('\n'));
    if(cust.vatNumber) lines.push('VAT No: '+cust.vatNumber);
    lines.filter(Boolean).forEach(function(line){ doc.splitTextToSize(String(line), 95).forEach(function(t){ doc.text(t, L, cy); cy += 4.2; }); });
    /* info box */
    var bx = 115.5, by = 46;
    var info = [['Credit Note Number', c.number, true], ['Date', fullDate(c.date)], ['Reference', c.invoiceNumber || '']];
    var acct = cust.accountNumber ? [['Account Number', cust.accountNumber]] : [['Job Number', c.jobNumber || '']];
    if(String(c.poNumber||'').trim()) acct.push(['Customer PO', String(c.poNumber).trim()]);
    var boxH = 8 + info.length*4.7 + 2 + acct.length*4.7;
    doc.setFillColor(PANEL[0],PANEL[1],PANEL[2]); doc.rect(bx, by, R-bx, boxH, 'F');
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(bx, by, R-bx, 0.7, 'F');
    var iy = by + 6.2;
    info.forEach(function(r){
      font('bold', 8.3); color([140,140,132]); doc.text(r[0], bx+3, iy);
      font(r[2] ? 'bold' : 'normal', 8.6); color(INK); doc.text(doc.splitTextToSize(String(r[1]), 40)[0] || '', R-3, iy, {align:'right'}); iy += 4.7;
    });
    doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.2); doc.line(bx+3, iy-2.4, R-3, iy-2.4);
    iy += 2.2;
    acct.forEach(function(r){
      font('bold', 8.3); color([140,140,132]); doc.text(r[0], bx+3, iy);
      font('normal', 8.6); color(INK); doc.text(String(r[1]), R-3, iy, {align:'right'}); iy += 4.7;
    });
    var y = Math.max(cy, by + boxH) + 9;
    /* lines */
    var C = {desc:L+2, qty:98, price:123, disc:142.5, tax:160, amt:R-1.5};
    function tableHead(){
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, W, 9.5, 'F');
      font('bold', 7.4); doc.setTextColor(255,255,255);
      spaced('DESCRIPTION', C.desc, y+5.9, null, 0.35);
      spaced('QTY', C.qty, y+5.9, {align:'right'}, 0.35);
      spaced('UNIT PRICE', C.price, y+5.9, {align:'right'}, 0.35);
      spaced('DISC %', C.disc, y+5.9, {align:'right'}, 0.35);
      spaced('VAT', C.tax, y+5.9, {align:'right'}, 0.35);
      spaced('AMOUNT', C.amt, y+4.3, {align:'right'}, 0.35);
      font('bold', 6.6); spaced(currency, C.amt, y+7.6, {align:'right'}, 0.35);
      y += 9.5 + 5;
    }
    tableHead();
    items.forEach(function(li){
      font('normal', 8.8);
      var dl = doc.splitTextToSize(String(li.description||''), 74);
      var rowH = Math.max(8, dl.length*4 + 4);
      if(y + rowH > 262){ footer(); doc.addPage(); y = 18; tableHead(); }
      color(INK); doc.text(dl, C.desc, y);
      doc.text(pdfQty(li.qty), C.qty, y, {align:'right'});
      doc.text(pdfNum(li.unitPrice), C.price, y, {align:'right'});
      doc.text(lineDiscPct(li) ? pdfNum(lineDiscPct(li)) : '0.00', C.disc, y, {align:'right'});
      doc.text(vatOn ? (rate+'%') : 'No VAT', C.tax, y, {align:'right'});
      doc.text(pdfNum(lineNet(li)), C.amt, y, {align:'right'});
      y += rowH;
      doc.setDrawColor(RULE[0],RULE[1],RULE[2]); doc.setLineWidth(0.2); doc.line(L, y-4, R, y-4);
    });
    /* totals */
    if(y > 215){ footer(); doc.addPage(); y = 20; }
    var lx = 158, vx = R-1.5, band = 96;
    y += 2;
    font('normal', 8.8); color(GREY);
    doc.text('Subtotal', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(c.subtotal), vx, y, {align:'right'});
    if(vatOn){ y += 6; color(GREY); doc.text('Total VAT '+rate+'%', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(c.vat), vx, y, {align:'right'}); }
    y += 3.5;
    doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.3); doc.line(band, y, R, y);
    y += 5.5;
    font('bold', 9.5); color(MAROON); doc.text('Credit Note Total '+currency, lx, y, {align:'right'}); doc.text(pdfNum(c.total), vx, y, {align:'right'});
    y += 6.5;
    var applied = c.voided ? 0 : Number(c.total)||0;
    font('normal', 8.8); color(GREY); doc.text('Less Credit Applied / Refunded', lx, y, {align:'right'}); color(INK); doc.text(pdfNum(applied), vx, y, {align:'right'});
    y += 3.5;
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(band, y, R-band, 11, 'F');
    font('bold', 10.5); doc.setTextColor(255,255,255);
    spaced('REMAINING CREDIT '+currency, lx, y+7, {align:'right'}, 0.1);
    doc.text(pdfNum(round2((Number(c.total)||0) - applied)), vx, y+7, {align:'right'});
    y += 11 + 5;
    font('bold', 8); color([140,140,132]);
    doc.text('Total Discount Given', lx, y, {align:'right'}); doc.text(pdfNum(linesDiscount(items)), vx, y, {align:'right'});
    y += 10;
    /* reason + applied-to note */
    font('normal', 8.6);
    var rl = doc.splitTextToSize(String(c.reason||''), W - 12);
    var applyTxt = 'Credit applied to invoice '+(c.invoiceNumber||'')+(c.jobTitle ? (' ('+c.jobTitle+')') : '')+'.';
    var boxH2 = 13 + rl.length*3.9 + 5;
    if(y + boxH2 + 14 > 272){ footer(); doc.addPage(); y = 20; }
    doc.setFillColor(PANEL[0],PANEL[1],PANEL[2]); doc.rect(L, y, W, boxH2, 'F');
    doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, 1.2, boxH2, 'F');
    font('bold', 7.6); color(MAROON); spaced('REASON FOR CREDIT', L+5, y+5.5, null, 0.6);
    font('normal', 8.6); color(INK); doc.text(rl, L+5, y+10.5);
    font('italic', 8); color(GREY); doc.text(applyTxt, L+5, y+10.5+rl.length*3.9+1.5);
    y += boxH2 + 8;
    if(c.voided){ font('bold', 9); doc.setTextColor(150,30,30); doc.text('VOID — '+(c.voidReason||''), L, y); y += 7; }
    font('normal', 8.6); color(GREY);
    var q1 = 'For any queries about this credit note, contact us on '+lh('docTel')+' or ';
    doc.text(q1, L, y);
    var q1w = doc.getTextWidth(q1);
    font('bold', 8.6); color(MAROON); doc.text(lh('docEmail')+'.', L + q1w, y);
    footer();
    return {blob:doc.output('blob'), filename:c.number+'.pdf'};
  }
  function downloadCreditNote(id){
    var c = (STATE.creditNotes||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var built = creditNotePdf(c); if(!built) return;
    if(STATE.downloads){ STATE.downloads.save({filename:built.filename, data:built.blob}).catch(function(err){ if(!err||err.code!=='declined') fallbackDownload(built.blob, built.filename); }); }
    else fallbackDownload(built.blob, built.filename);
  }
  function sendCreditNoteWhatsapp(id){
    var c = (STATE.creditNotes||[]).find(function(x){ return x.id===id; }); if(!c) return;
    var phone = waPhone(c.phone); if(!phone){ toast('No phone number on file for this customer'); return; }
    if(!STATE.mcp){ toast('WhatsApp isn’t set up — download the credit note instead'); return; }
    var built = creditNotePdf(c); if(!built) return;
    STATE.creditForm = null;
    STATE.openOrderId = c.orderId;
    openOrderChat(phone);
    attachFileToChat(phone, built.blob, built.filename, 'application/pdf', 'Hi '+(c.customerName||'there')+', here is credit note '+c.number+' for '+money(c.total)+' on invoice '+c.invoiceNumber+'.');
    render();
  }

  /* ============================ exports tab ============================ */
  function cnInRange(){
    var from = STATE.cnExFrom||'', to = STATE.cnExTo||'';
    if(from && to && from > to){ var t = from; from = to; to = t; }
    return (STATE.creditNotes||[]).filter(function(c){ return !c.voided && (!from || c.date >= from) && (!to || c.date <= to); })
      .sort(function(a,b){ return String(a.date).localeCompare(String(b.date)) || String(a.number).localeCompare(String(b.number)); });
  }
  // Same 44 columns as the Xero "SalesInvoices" file; Type = "Sales credit note".
  function xeroCreditRows(c){
    var o = STATE.orders.find(function(x){ return x.id===c.orderId; }) || {};
    var cust = STATE.customers.find(function(x){ return x.id===(c.customerId||o.customerId); }) || {};
    var vatOn = !!c.vatEnabled, rate = vatOn ? (Number(c.vatRate)||Number(STATE.config.vatRate)||0)/100 : 0;
    var lines = (c.items||[]).map(function(li){ var amount = round2(lineNet(li)); return {desc:li.description||'', qty:Number(li.qty)||0, unit:Number(li.unitPrice)||0, disc:lineDiscPct(li), amount:amount, tax:round2(amount*rate)}; });
    var taxTotal = round2(Number(c.vat)||lines.reduce(function(s,l){ return s+l.tax; },0));
    var total = round2(Number(c.total)||0);
    var reps = [c.designerName, c.technicianName, c.technician2Name].filter(Boolean).map(firstName).filter(function(n,i,a){ return a.indexOf(n)===i; }).join(' & ');
    return lines.map(function(l){
      var r = {};
      XERO_INVOICE_COLUMNS.forEach(function(k){ r[k] = ''; });
      r.ContactName = c.customerName || cust.name || '';
      r.EmailAddress = cust.email || '';
      var ipa = cust.postalAddress || {}, ida = cust.postalAddress ? customerDeliveryAddress(cust) : {};
      r.POAddressLine1 = ipa.line1||''; r.POAddressLine2 = ipa.line2||''; r.POCity = ipa.city||''; r.PORegion = ipa.region||''; r.POPostalCode = ipa.postalCode||''; r.POCountry = addrHasData(ipa) ? (ipa.country||'') : '';
      r.SAAddressLine1 = ida.line1||''; r.SAAddressLine2 = ida.line2||''; r.SACity = ida.city||''; r.SARegion = ida.region||''; r.SAPostalCode = ida.postalCode||''; r.SACountry = addrHasData(ida) ? (ida.country||'') : '';
      r.InvoiceNumber = c.number;
      r.Reference = c.invoiceNumber || '';
      r.InvoiceDate = dmy(c.date);
      r.DueDate = dmy(c.date);
      r.Total = f4(total);
      r.TaxTotal = f4(taxTotal);
      r.InvoiceAmountPaid = f4(0);
      r.InvoiceAmountDue = f4(total);
      r.Description = l.desc;
      r.Quantity = f4(l.qty);
      r.UnitAmount = f4(l.unit);
      r.Discount = l.disc ? f4(l.disc) : '';
      r.LineAmount = f4(l.amount);
      r.AccountCode = STATE.config.accountCode || '200';
      r.TaxType = vatOn ? (STATE.config.xeroTaxVat || 'Standard Rate Sales') : (STATE.config.xeroTaxNoVat || 'No VAT');
      r.TaxAmount = f4(l.tax);
      r.TrackingName1 = STATE.config.xeroTrackingName || 'Sales Rep';
      r.TrackingOption1 = reps;
      r.Currency = STATE.config.currency || 'ZAR';
      r.Type = 'Sales credit note';
      r.Sent = 'Unsent';
      r.Status = STATE.cnExStatus || 'Draft';
      return r;
    });
  }
  function exportCreditNotesXero(){
    if(!isOwnerRole()) return;
    var list = cnInRange();
    if(!list.length){ toast('No credit notes in that date range'); return; }
    var out = [XERO_INVOICE_COLUMNS.join(',')];
    list.forEach(function(c){ xeroCreditRows(c).forEach(function(r){ out.push(XERO_INVOICE_COLUMNS.map(function(k){ return csvCell(r[k]); }).join(',')); }); });
    var csv = out.join('\r\n') + '\r\n';
    var tag = (STATE.cnExFrom||STATE.cnExTo) ? ((STATE.cnExFrom||'start')+'_to_'+(STATE.cnExTo||todayIso())+'_') : '';
    var filename = 'SalesCreditNotes_DsignX_'+tag+todayIso()+'.csv';
    var done = function(){ toast('Exported '+list.length+' credit note'+(list.length===1?'':'s')); };
    if(STATE.downloads){
      STATE.downloads.save({filename:filename, data:csv}).then(done).catch(function(e){
        if(e && e.code==='declined'){ toast('Export cancelled'); } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
      });
    } else { fallbackDownload(new Blob([csv],{type:'text/csv'}), filename); done(); }
  }
  function renderCreditExportPanel(){
    var list = cnInRange();
    var lineCount = 0, grand = 0;
    list.forEach(function(c){ lineCount += (c.items||[]).length; grand += Number(c.total)||0; });
    var statusOpts = ['Draft','Awaiting Approval','Awaiting Payment'].map(function(v){ return '<option'+((STATE.cnExStatus||'Draft')===v?' selected':'')+'>'+v+'</option>'; }).join('');
    return '<div class="panel">' +
      '<div class="section-label">Export credit notes (Xero sales invoice template)</div>' +
      '<div class="hint" style="margin:-4px 0 12px;">Same 44 columns as the invoice export, one row per line, with Type “Sales credit note”. The credit note number goes in InvoiceNumber and the invoice it credits in Reference. Voided credit notes are left out.</div>' +
      '<div class="section-label" style="margin-bottom:6px;">Credit note dates to export</div>' +
      '<div class="filterbar" style="margin-bottom:10px;">' + invExportPresets().map(function(p){
        var on = (STATE.cnExFrom||'')===p.from && (STATE.cnExTo||'')===p.to;
        return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="cn-ex-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>';
      }).join('') + '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="cnExFrom">From</label><input type="date" id="cnExFrom" value="'+escapeHtml(STATE.cnExFrom||'')+'"></div>' +
        '<div class="field"><label for="cnExTo">To</label><input type="date" id="cnExTo" value="'+escapeHtml(STATE.cnExTo||'')+'"></div>' +
      '</div>' +
      '<div class="field"><label for="cnExStatus">Import into Xero as</label><select id="cnExStatus" style="max-width:220px;">'+statusOpts+'</select><div class="hint">Tax types and tracking name are the same as for invoices.</div></div>' +
      '<div style="background:var(--surface-2); border-radius:var(--radius-s); padding:10px 12px; font-size:12.5px; color:var(--ink-soft); margin-bottom:12px;">' +
        (list.length ? ('<strong style="color:var(--ink);">'+list.length+' credit note'+(list.length===1?'':'s')+'</strong> &middot; '+lineCount+' line'+(lineCount===1?'':'s')+' &middot; '+money(round2(grand))+' incl. VAT') : 'No credit notes in these dates.') +
      '</div>' +
      '<button class="btn btn-primary btn-sm" data-action="export-cn-xero"'+(list.length?'':' disabled')+'>Download CSV</button>' +
    '</div>';
  }
  function renderXeroDefaultsPanel(){
    return '<div class="panel">' +
      '<div class="section-label">Xero export defaults</div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="cfgAccount">Account code</label><input type="text" id="cfgAccount" value="'+escapeHtml(STATE.config.accountCode||'')+'"></div>' +
        '<div class="field"><label for="cfgTax">Tax type</label><input type="text" id="cfgTax" value="'+escapeHtml(STATE.config.taxType||'')+'"></div>' +
      '</div>' +
      '<div class="field"><label for="cfgCurrency">Currency</label><input type="text" id="cfgCurrency" style="max-width:110px" value="'+escapeHtml(STATE.config.currency||'ZAR')+'"></div>' +
      '<button class="btn btn-primary btn-sm" data-action="save-xero-defaults">Save</button>' +
    '</div>';
  }
  function renderExportsTab(){
    return '<div class="topline"><div><h1>Exports</h1><div class="sub">Download invoices, credit notes, customers and receipts for Xero and your bank statement import</div></div></div>' +
      '<div class="two-col">' +
        '<div>' + renderInvoiceExportPanel() + renderCreditExportPanel() + '</div>' +
        '<div>' + renderReceiptExportPanel() + renderCustomerExportPanel() + renderXeroDefaultsPanel() + '</div>' +
      '</div>';
  }

  /* ============================ age analysis ============================ */
  var AGE_BUCKETS = [{key:'b0', label:'Current', note:'0–30 days'}, {key:'b30', label:'31–60 days'}, {key:'b60', label:'61–90 days'}, {key:'b90', label:'91–120 days'}, {key:'b120', label:'120+ days'}];
  function daysBetween(a, b){ return Math.round((new Date(b+'T00:00:00') - new Date(a+'T00:00:00')) / 86400000); }
  function ageBucket(days){ return days <= 30 ? 'b0' : days <= 60 ? 'b30' : days <= 90 ? 'b60' : days <= 120 ? 'b90' : 'b120'; }
  function ageAsAt(){ if(!STATE.ageAsAt) STATE.ageAsAt = todayIso(); return STATE.ageAsAt; }
  function ageInvoices(asAt){
    return STATE.orders.filter(function(o){ return !o.quoteOnly && (hasInvoiceDoc(o) || isSale(o)); }).map(function(o){
      var date = invoiceDateOf(o);
      if(date > asAt) return null;
      var gross = invoiceGross(o);
      var paid = round2(STATE.receipts.filter(function(r){ return r.orderId===o.id && !r.voided && String(r.date) <= asAt; }).reduce(function(s,r){ return s + (Number(r.amount)||0); }, 0));
      var credit = round2((STATE.creditNotes||[]).filter(function(c){ return c.orderId===o.id && !c.voided && String(c.date) <= asAt; }).reduce(function(s,c){ return s + (Number(c.total)||0); }, 0));
      var bal = round2(gross - paid - credit);
      if(!(bal > 0.004)) return null;
      var due = addDays(date, o.invoiceDueDays!=null ? Number(o.invoiceDueDays) : (Number(STATE.config.invoiceDueDays)||7));
      var days = Math.max(0, daysBetween(date, asAt));
      return {o:o, number:o.invoiceNumber || jobNo(o.id), date:date, due:due, days:days, overdue:Math.max(0, daysBetween(due, asAt)), gross:gross, paid:paid, credit:credit, balance:bal, bucket:ageBucket(days)};
    }).filter(Boolean);
  }
  function ageAnalysis(asAt){
    var inv = ageInvoices(asAt), map = {};
    inv.forEach(function(x){
      var o = x.o, k = o.customerId || ('n:'+String(o.customerName||'').trim().toLowerCase());
      var cust = STATE.customers.find(function(c){ return c.id===o.customerId; }) || {};
      if(!map[k]) map[k] = {key:k, name:o.customerName || cust.name || 'Customer', phone:o.phone || cust.phone || '', invoices:[], b0:0, b30:0, b60:0, b90:0, b120:0, total:0, oldest:0};
      var g = map[k];
      g.invoices.push(x); g[x.bucket] = round2(g[x.bucket] + x.balance); g.total = round2(g.total + x.balance); g.oldest = Math.max(g.oldest, x.days);
    });
    var rows = Object.keys(map).map(function(k){ var g = map[k]; g.invoices.sort(function(a,b){ return a.date.localeCompare(b.date); }); return g; })
      .sort(function(a,b){ return b.total - a.total || a.name.localeCompare(b.name); });
    var t = {b0:0, b30:0, b60:0, b90:0, b120:0, total:0, count:inv.length};
    rows.forEach(function(g){ AGE_BUCKETS.forEach(function(b){ t[b.key] = round2(t[b.key] + g[b.key]); }); t.total = round2(t.total + g.total); });
    return {rows:rows, totals:t};
  }
  function pctOf(part, whole){ return whole ? Math.round(part / whole * 1000) / 10 : 0; }
  function renderAgeReport(){
    var asAt = ageAsAt(), a = ageAnalysis(asAt), t = a.totals;
    var cell = function(v){ return '<td class="num">'+(v ? money(v) : '<span style="color:var(--ink-faint);">—</span>')+'</td>'; };
    var body = a.rows.length ? a.rows.map(function(g){
      var open = STATE.ageOpen===g.key;
      var head = '<tr class="row-btn" data-action="age-toggle" data-id="'+escapeHtml(g.key)+'"><td><strong>'+(open?'▾ ':'▸ ')+escapeHtml(g.name)+'</strong><div class="hint" style="margin:0;">'+g.invoices.length+' invoice'+(g.invoices.length===1?'':'s')+(g.phone?' &middot; '+escapeHtml(g.phone):'')+'</div></td>' +
        AGE_BUCKETS.map(function(b){ return cell(g[b.key]); }).join('') + '<td class="num"><strong>'+money(g.total)+'</strong></td></tr>';
      if(!open) return head;
      return head + g.invoices.map(function(x){
        return '<tr class="age-inv row-btn" data-action="open-order" data-id="'+x.o.id+'"><td style="padding-left:26px;"><span class="mono">'+escapeHtml(x.number)+'</span> &middot; '+shortDate(x.date)+' &middot; '+x.days+' day'+(x.days===1?'':'s')+(x.overdue?(' &middot; <span style="color:#a12222;">'+x.overdue+' overdue</span>'):'')+
          '<div class="hint" style="margin:0;">Invoice '+money(x.gross)+(x.paid?' &middot; paid '+money(x.paid):'')+(x.credit?' &middot; credited '+money(x.credit):'')+'</div></td>' +
          AGE_BUCKETS.map(function(b){ return cell(b.key===x.bucket ? x.balance : 0); }).join('') + '<td class="num">'+money(x.balance)+'</td></tr>';
      }).join('');
    }).join('') + '<tr class="total-row"><td>Total &middot; '+a.rows.length+' customer'+(a.rows.length===1?'':'s')+'</td>'+AGE_BUCKETS.map(function(b){ return '<td class="num">'+money(t[b.key])+'</td>'; }).join('')+'<td class="num">'+money(t.total)+'</td></tr>' +
      '<tr><td style="color:var(--ink-soft);">% of total</td>'+AGE_BUCKETS.map(function(b){ return '<td class="num" style="color:var(--ink-soft);">'+pctOf(t[b.key], t.total)+'%</td>'; }).join('')+'<td class="num" style="color:var(--ink-soft);">100%</td></tr>'
      : '<tr><td colspan="7" class="empty-note">No unpaid invoices as at '+fullDate(asAt)+'.</td></tr>';
    var over60 = round2(t.b60 + t.b90 + t.b120);
    return '<div class="topline"><div><h1>Reports</h1><div class="sub">Customer age analysis &middot; unpaid invoices as at '+fullDate(asAt)+'</div></div>' +
        '<div style="display:flex; gap:8px;"><button class="btn btn-sm" data-action="age-xlsx"'+(a.rows.length?'':' disabled')+'>Download Excel</button><button class="btn btn-primary btn-sm" data-action="age-pdf"'+(a.rows.length?'':' disabled')+'>Download PDF</button></div></div>' +
      reportSwitcher() +
      '<div class="panel" style="padding:12px 14px; margin-bottom:16px;"><div class="period-bar">' +
        '<label for="ageAsAt" style="margin:0;">As at</label><input type="date" id="ageAsAt" value="'+escapeHtml(asAt)+'" style="width:auto;">' +
        '<button type="button" class="chip-toggle'+(asAt===todayIso()?' active':'')+'" data-action="age-today">Today</button>' +
        '<span class="hint" style="margin:0 0 0 8px;">Invoices are aged from the invoice date. Payments and credit notes dated after the “as at” date are not counted.</span>' +
      '</div></div>' +
      '<div class="tiles">' +
        tile('Total outstanding', money(t.total), t.count+' unpaid invoice'+(t.count===1?'':'s')) +
        tile('Current (0–30 days)', money(t.b0), pctOf(t.b0, t.total)+'% of the total') +
        tile('Older than 60 days', money(over60), pctOf(over60, t.total)+'% of the total') +
        tile('Customers owing', String(a.rows.length), a.rows[0] ? ('Largest: '+escapeHtml(a.rows[0].name)) : 'Nobody owes anything') +
      '</div>' +
      '<div class="panel"><div class="tbl-wrap"><table class="age-table"><thead><tr><th>Customer</th>'+AGE_BUCKETS.map(function(b){ return '<th class="num">'+b.label+(b.note?'<div style="font-weight:400; font-size:10.5px;">'+b.note+'</div>':'')+'</th>'; }).join('')+'<th class="num">Total due</th></tr></thead><tbody>'+body+'</tbody></table></div>' +
      '<div class="hint">Click a customer to see their invoices; click an invoice to open the job.</div></div>';
  }
  function ageReportXlsx(){
    var asAt = ageAsAt(), a = ageAnalysis(asAt), t = a.totals;
    var H = function(x){ return {v:x, s:4}; }, B = function(v){ return {v:v, s:3}; };
    var sum = [[H('Customer'),H('Phone'),H('Invoices')].concat(AGE_BUCKETS.map(function(b){ return H(b.label); })).concat([H('Total due'),H('Oldest (days)')])];
    a.rows.forEach(function(g){ sum.push([g.name, g.phone, {v:g.invoices.length, s:5}].concat(AGE_BUCKETS.map(function(b){ return g[b.key]; })).concat([B(g.total), {v:g.oldest, s:5}])); });
    sum.push([]);
    sum.push([{v:'Total', s:1}, '', {v:t.count, s:5}].concat(AGE_BUCKETS.map(function(b){ return B(t[b.key]); })).concat([B(t.total)]));
    sum.push([{v:'% of total', s:1}, '', ''].concat(AGE_BUCKETS.map(function(b){ return pctOf(t[b.key], t.total)+'%'; })).concat(['100%']));
    var det = [[H('Customer'),H('Invoice'),H('Job'),H('Invoice date'),H('Due date'),H('Age (days)'),H('Days overdue'),H('Age bucket'),H('Invoice total'),H('Paid'),H('Credited'),H('Balance due')]];
    a.rows.forEach(function(g){ g.invoices.forEach(function(x){
      var b = AGE_BUCKETS.find(function(z){ return z.key===x.bucket; });
      det.push([g.name, x.number, x.o.jobNumber||jobNo(x.o.id), x.date, x.due, {v:x.days, s:5}, {v:x.overdue, s:5}, b.label, x.gross, x.paid, x.credit, B(x.balance)]);
    }); });
    var blob = buildXlsx([
      {name:'Age analysis', widths:[30,16,10,14,14,14,14,14,14,13], rows:[[{v:'Customer age analysis as at '+fullDate(asAt), s:1}], []].concat(sum)},
      {name:'Invoices', widths:[30,14,12,12,12,10,12,13,14,12,12,14], rows:det}
    ]);
    var name = 'DsignX-age-analysis-'+asAt+'.xlsx';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }
  function ageReportPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return; }
    var asAt = ageAsAt(), a = ageAnalysis(asAt), t = a.totals;
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4', orientation:'landscape'});
    var L = 12, R = 285, MAROON = [78,9,40];
    var cols = [['CUSTOMER / INVOICE',L+1,'l'],['CURRENT',L+118,'r'],['31–60 DAYS',L+143,'r'],['61–90 DAYS',L+168,'r'],['91–120 DAYS',L+193,'r'],['120+ DAYS',L+218,'r'],['TOTAL DUE',L+246,'r'],['OLDEST',L+272,'r']];
    var header = function(){
      try { doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 8, 36, 36*(358/800)); } catch(e){}
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(lh('docCompanyName'), R, 13, {align:'right'});
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(95,99,88); doc.text(lh('docAddress'), R, 17.5, {align:'right'});
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 26, R-L, 0.7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text('CUSTOMER AGE ANALYSIS', L, 35);
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(60,60,60); doc.text('Unpaid invoices as at '+fullDate(asAt)+'   ·   Aged from invoice date   ·   Generated '+fullDate(todayIso()), L, 40.5);
      var y = 45;
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, R-L, 7.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7); doc.setTextColor(255,255,255);
      cols.forEach(function(c){ doc.text(c[0], c[1], y+5, c[2]==='r'?{align:'right'}:{}); });
      return y + 7.5;
    };
    var n = function(v){ return v ? pdfNum(v) : '—'; };
    var y = header();
    a.rows.forEach(function(g, i){
      var need = 7 + g.invoices.length*5.2;
      if(y + Math.min(need, 20) > 190){ doc.addPage(); y = header(); }
      doc.setFillColor(246,245,241); doc.rect(L, y, R-L, 7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(8.4); doc.setTextColor(43,43,43);
      doc.text(doc.splitTextToSize(g.name+(g.phone?('  ·  '+g.phone):''), 100)[0], cols[0][1], y+4.8);
      [g.b0, g.b30, g.b60, g.b90, g.b120, g.total].forEach(function(v, k){ doc.text(n(v), cols[k+1][1], y+4.8, {align:'right'}); });
      doc.text(g.oldest+'d', cols[7][1], y+4.8, {align:'right'});
      y += 7;
      g.invoices.forEach(function(x){
        if(y + 5.2 > 192){ doc.addPage(); y = header(); }
        doc.setFont('helvetica','normal'); doc.setFontSize(7.6); doc.setTextColor(80,80,80);
        doc.text(x.number+'   '+fullDate(x.date)+'   due '+fullDate(x.due)+(x.credit?('   credited '+pdfNum(x.credit)):'')+(x.paid?('   paid '+pdfNum(x.paid)):''), cols[0][1]+4, y+3.8);
        AGE_BUCKETS.forEach(function(b, k){ if(b.key===x.bucket) doc.text(pdfNum(x.balance), cols[k+1][1], y+3.8, {align:'right'}); });
        doc.text(pdfNum(x.balance), cols[6][1], y+3.8, {align:'right'});
        doc.text(x.days+'d', cols[7][1], y+3.8, {align:'right'});
        y += 5.2;
      });
      y += 1.5;
    });
    if(y + 16 > 192){ doc.addPage(); y = header(); }
    doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.4); doc.line(L, y+0.5, R, y+0.5);
    doc.setFont('helvetica','bold'); doc.setFontSize(8.4); doc.setTextColor(43,43,43);
    doc.text('TOTAL  ·  '+a.rows.length+' customers  ·  '+t.count+' invoices', cols[0][1], y+5.5);
    [t.b0, t.b30, t.b60, t.b90, t.b120, t.total].forEach(function(v, k){ doc.text(pdfNum(v), cols[k+1][1], y+5.5, {align:'right'}); });
    doc.setFont('helvetica','normal'); doc.setFontSize(7.8); doc.setTextColor(95,99,88);
    doc.text('% of total', cols[0][1], y+10.5);
    [t.b0, t.b30, t.b60, t.b90, t.b120].forEach(function(v, k){ doc.text(pctOf(v, t.total)+'%', cols[k+1][1], y+10.5, {align:'right'}); });
    doc.text('100%', cols[6][1], y+10.5, {align:'right'});
    doc.text('Amounts in '+(STATE.config.currency||'ZAR')+' incl. VAT, after payments and credit notes.', L, Math.min(y+17, 196));
    var blob = doc.output('blob'), name = 'DsignX-age-analysis-'+asAt+'.pdf';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* ============================ quote success statistics ============================ */
  var WON_STATUSES = ['designing','approval','printing','production','invoiced','ready','collected','in_progress','delivered'];
  function quoteValidUntil(o){ return addDays(String(o.quoteGeneratedAt).slice(0,10), Number(o.quoteValidDays)||Number(STATE.config.quoteValidityDays)||14); }
  function quoteOutcome(o){
    if(hasInvoiceDoc(o) || isSale(o) || WON_STATUSES.indexOf(o.status)>=0 || orderPaid(o.id) > 0) return 'won';
    return quoteValidUntil(o) < todayIso() ? 'lost' : 'open';
  }
  function quoteValueEx(o){ return round2((o.lineItems||[]).length ? (o.lineItems||[]).reduce(function(s,li){ return s + lineNet(li); }, 0) : (Number(o.quoteAmount)||0)); }
  function quotesIssued(r){
    return STATE.orders.filter(function(o){
      if(!o.quoteNumber || !o.quoteGeneratedAt) return false;
      var d = String(o.quoteGeneratedAt).slice(0,10);
      return (!r.from || d >= r.from) && (!r.to || d <= r.to);
    }).map(function(o){ return {o:o, date:String(o.quoteGeneratedAt).slice(0,10), outcome:quoteOutcome(o), value:quoteValueEx(o), designer:o.designerName || 'Unassigned'}; })
      .sort(function(a,b){ return a.date.localeCompare(b.date) || String(a.o.quoteNumber).localeCompare(String(b.o.quoteNumber)); });
  }
  function qsSummarise(list){
    var s = {count:list.length, won:0, lost:0, open:0, value:0, wonValue:0, lostValue:0, openValue:0};
    list.forEach(function(q){ s[q.outcome]++; s.value += q.value; s[q.outcome+'Value'] += q.value; });
    ['value','wonValue','lostValue','openValue'].forEach(function(k){ s[k] = round2(s[k]); });
    s.rate = pctOf(s.won, s.won + s.lost);           // of quotes that have been decided
    s.valueRate = pctOf(s.wonValue, s.wonValue + s.lostValue);
    s.conversion = pctOf(s.won, s.count);             // of every quote issued
    return s;
  }
  function qsGroups(list, keyFn){
    var m = {}, order = [];
    list.forEach(function(q){ var k = keyFn(q); if(!m[k]){ m[k] = []; order.push(k); } m[k].push(q); });
    return order.map(function(k){ return {key:k, s:qsSummarise(m[k])}; });
  }
  var OUTCOME_LABEL = {won:'Accepted', lost:'Expired / not accepted', open:'Open — still valid'};
  function renderQuoteStats(range){
    var list = quotesIssued(range), s = qsSummarise(list);
    var byDesigner = qsGroups(list, function(q){ return q.designer; }).sort(function(a,b){ return b.s.count - a.s.count; });
    var byMonth = qsGroups(list, function(q){ return q.date.slice(0,7); });
    var gRows = function(groups, labelFn){
      return groups.length ? groups.map(function(g){ return '<tr><td>'+escapeHtml(labelFn(g.key))+'</td><td class="num">'+g.s.count+'</td><td class="num">'+g.s.won+'</td><td class="num">'+g.s.lost+'</td><td class="num">'+g.s.open+'</td><td class="num"><strong>'+(g.s.won+g.s.lost ? g.s.rate+'%' : '—')+'</strong></td><td class="num">'+money(g.s.value)+'</td><td class="num">'+money(g.s.wonValue)+'</td></tr>'; }).join('')
        : '<tr><td colspan="8" class="empty-note">No quotations issued in this period.</td></tr>';
    };
    var head = '<thead><tr><th></th><th class="num">Issued</th><th class="num">Accepted</th><th class="num">Expired</th><th class="num">Open</th><th class="num">Success rate</th><th class="num">Quoted value</th><th class="num">Accepted value</th></tr></thead>';
    var chip = {won:'pay-paid', lost:'pay-unpaid', open:'pay-part'};
    var qRows = list.length ? list.slice().reverse().map(function(q){
      return '<tr class="row-btn" data-action="open-order" data-id="'+q.o.id+'"><td class="mono">'+escapeHtml(q.o.quoteNumber)+'</td><td>'+shortDate(q.date)+'</td><td>'+escapeHtml(q.o.customerName||'')+'</td><td>'+escapeHtml(q.o.title||'')+'</td><td>'+escapeHtml(q.designer)+'</td><td class="num">'+money(q.value)+'</td><td><span class="pay-chip '+chip[q.outcome]+'">'+OUTCOME_LABEL[q.outcome]+'</span></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty-note">No quotations issued in this period.</td></tr>';
    var bar = '<div class="panel" style="padding:12px 14px; margin-bottom:16px;"><div class="period-bar">' +
      reportPresets().map(function(p){ var on = range.from===p.from && range.to===p.to; return '<button type="button" class="chip-toggle'+(on?' active':'')+'" data-action="report-preset" data-from="'+p.from+'" data-to="'+p.to+'">'+p.label+'</button>'; }).join('') +
      '<span style="flex:1"></span>' +
      '<label for="reportFrom" style="margin:0;">From</label><input type="date" id="reportFrom" value="'+escapeHtml(range.from||'')+'" style="width:auto;">' +
      '<label for="reportTo" style="margin:0;">To</label><input type="date" id="reportTo" value="'+escapeHtml(range.to||'')+'" style="width:auto;">' +
      '</div></div>';
    var meter = '<div class="qs-meter" title="Accepted / expired / open"><span class="qs-won" style="width:'+pctOf(s.won, s.count)+'%"></span><span class="qs-open" style="width:'+pctOf(s.open, s.count)+'%"></span><span class="qs-lost" style="width:'+pctOf(s.lost, s.count)+'%"></span></div>';
    return '<div class="topline"><div><h1>Reports</h1><div class="sub">Quotation success rate &middot; quotes issued '+rangeLabel(range)+'</div></div>' +
        '<div style="display:flex; gap:8px;"><button class="btn btn-primary btn-sm" data-action="qs-xlsx"'+(list.length?'':' disabled')+'>Download Excel</button></div></div>' +
      reportSwitcher() + bar +
      '<div class="tiles">' +
        tile('Success rate', (s.won+s.lost ? s.rate+'%' : '—'), s.won+' accepted of '+(s.won+s.lost)+' decided') +
        tile('Quotes issued', String(s.count), money(s.value)+' excl. VAT') +
        tile('Accepted value', money(s.wonValue), (s.wonValue+s.lostValue ? s.valueRate+'% of decided value' : 'Nothing decided yet')) +
        tile('Still open', String(s.open), money(s.openValue)+' awaiting a decision') +
      '</div>' +
      '<div class="panel">' + meter +
        '<div class="hint" style="margin-top:8px;"><span class="qs-key qs-won"></span>Accepted '+s.won+' &nbsp; <span class="qs-key qs-open"></span>Open '+s.open+' &nbsp; <span class="qs-key qs-lost"></span>Expired '+s.lost+' &nbsp;&middot;&nbsp; Overall conversion '+s.conversion+'% of all quotes issued.</div>' +
        '<div class="hint">A quote counts as <strong>accepted</strong> once the job moves to Designing or further, a deposit or payment is received, or it is invoiced. It counts as <strong>expired</strong> when its validity date has passed without that. The success rate leaves out quotes that are still open.</div>' +
      '</div>' +
      '<div class="panel"><div class="section-label">By designer</div><div class="tbl-wrap"><table>'+head+'<tbody>'+gRows(byDesigner, function(k){ return k; })+'</tbody></table></div></div>' +
      '<div class="panel"><div class="section-label">By month</div><div class="tbl-wrap"><table>'+head+'<tbody>'+gRows(byMonth, monthLabel)+'</tbody></table></div></div>' +
      '<div class="panel"><div class="section-label">Quotations issued</div><div class="tbl-wrap"><table><thead><tr><th>Quote</th><th>Date</th><th>Customer</th><th>Job</th><th>Designer</th><th class="num">Value excl. VAT</th><th>Outcome</th></tr></thead><tbody>'+qRows+'</tbody></table></div></div>';
  }
  function quoteStatsXlsx(){
    var range = reportRange(), list = quotesIssued(range), s = qsSummarise(list);
    var H = function(x){ return {v:x, s:4}; }, I = function(v){ return {v:v, s:5}; };
    var sum = [[{v:'Quotation success rate — quotes issued '+rangeLabel(range), s:1}], [],
      [H('Measure'), H('Count'), H('Value excl. VAT')],
      ['Quotes issued', I(s.count), s.value], ['Accepted', I(s.won), s.wonValue], ['Expired / not accepted', I(s.lost), s.lostValue], ['Open — still valid', I(s.open), s.openValue], [],
      [{v:'Success rate (accepted ÷ decided)', s:1}, (s.won+s.lost ? s.rate+'%' : '—'), (s.wonValue+s.lostValue ? s.valueRate+'%' : '—')],
      [{v:'Overall conversion (accepted ÷ issued)', s:1}, s.conversion+'%', pctOf(s.wonValue, s.value)+'%']];
    var grp = function(groups, labelFn){
      var rows = [[H(''), H('Issued'), H('Accepted'), H('Expired'), H('Open'), H('Success rate'), H('Quoted value'), H('Accepted value')]];
      groups.forEach(function(g){ rows.push([labelFn(g.key), I(g.s.count), I(g.s.won), I(g.s.lost), I(g.s.open), (g.s.won+g.s.lost ? g.s.rate+'%' : '—'), g.s.value, g.s.wonValue]); });
      return rows;
    };
    var quotes = [[H('Quote'), H('Date'), H('Valid until'), H('Customer'), H('Job'), H('Designer'), H('Value excl. VAT'), H('Outcome'), H('Invoice')]];
    list.forEach(function(q){ quotes.push([q.o.quoteNumber, q.date, quoteValidUntil(q.o), q.o.customerName||'', q.o.title||'', q.designer, q.value, OUTCOME_LABEL[q.outcome], q.o.invoiceNumber && q.o.invoiceGeneratedAt ? q.o.invoiceNumber : '']); });
    var blob = buildXlsx([
      {name:'Summary', widths:[40,12,16], rows:sum},
      {name:'By designer', widths:[22,9,10,9,8,13,15,15], rows:grp(qsGroups(list, function(q){ return q.designer; }), function(k){ return k; })},
      {name:'By month', widths:[18,9,10,9,8,13,15,15], rows:grp(qsGroups(list, function(q){ return q.date.slice(0,7); }), monthLabel)},
      {name:'Quotes', widths:[14,12,12,28,30,16,15,22,14], rows:quotes}
    ]);
    var name = 'DsignX-quote-success-'+(range.from||'start')+'-to-'+(range.to||todayIso())+'.xlsx';
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* ============================ internal messages: enquiries & ad hoc tasks ============================ */
  // One document per enquiry/task in messages/. Only the sender and the receiver (and the owner) can read it.
  // attn[memberId] = true means that person has something new to look at (drives the menu badge).
  var MSG_STATUS = {pending:'Waiting to be accepted', accepted:'Accepted', finished:'Finished'};
  function myMsgId(){ return isOwnerRole() ? 'owner' : (STATE.currentUserId || ''); }
  function myMsgName(){ var m = currentTeamMember(); return m ? m.name : 'Owner'; }
  function msgPeople(){
    var me = myMsgId();
    var list = STATE.team.filter(function(m){ return m.active!==false && m.id!==me; }).map(function(m){ return {id:m.id, name:m.name, role:roleLabel(m.role)}; });
    if(me!=='owner') list.unshift({id:'owner', name:'Owner', role:'Owner'});
    return list;
  }
  var _msgUnsubs = [], _msgSeenAttn = null;
  function startMessageFeed(){
    if(!STATE.db || _msgUnsubs.length) return;
    var me = myMsgId(); if(!me) return;
    if(!STATE.assets && window.DSX && window.DSX.assets) STATE.assets = window.DSX.assets; // technicians attach files too
    if(!STATE.downloads && window.DSX) STATE.downloads = window.DSX.downloads;
    var buckets = {};
    var merge = function(){
      var map = {};
      Object.keys(buckets).forEach(function(k){ buckets[k].forEach(function(m){ map[m.id] = m; }); });
      var all = Object.keys(map).map(function(k){ return map[k]; });
      if(!isOwnerRole()) all = all.filter(function(m){ return m.fromId===me || m.toId===me; });
      all.sort(function(a,b){ return String(b.updatedAt||b.createdAt).localeCompare(String(a.updatedAt||a.createdAt)); });
      // a toast when something new lands for me
      var attnNow = all.filter(function(m){ return m.attn && m.attn[me]; });
      if(_msgSeenAttn){
        var fresh = attnNow.filter(function(m){ return _msgSeenAttn[m.id]!==(m.updatedAt||''); });
        if(fresh.length && STATE.msgOpenId!==fresh[0].id) toast(msgToastText(fresh[0]));
      }
      _msgSeenAttn = {}; attnNow.forEach(function(m){ _msgSeenAttn[m.id] = m.updatedAt||''; });
      STATE.messages = all;
      if(STATE.tab==='messages' && STATE.msgOpenId){ var open = all.find(function(m){ return m.id===STATE.msgOpenId; }); if(open && open.attn && open.attn[me]) clearMsgAttn(open); }
      renderKeepMsgDraft();
    };
    var listen = function(key, q){
      _msgUnsubs.push(q.onSnapshot(function(qs){ buckets[key] = qs.docs.map(function(d){ return Object.assign({id:d.id}, d.data()); }); merge(); }, function(){}));
    };
    if(isOwnerRole()) listen('all', STATE.db.collection('messages'));
    else { listen('from', STATE.db.collection('messages').where('fromId','==',me)); listen('to', STATE.db.collection('messages').where('toId','==',me)); }
  }
  function msgToastText(m){
    var last = (m.log||[])[m.log ? m.log.length-1 : 0];
    if(!last) return 'New '+(m.kind==='task'?'task':'enquiry')+' from '+m.fromName+': '+m.subject;
    if(last.type==='system') return 'Payment reminder: '+m.subject.replace(/^Payment overdue:\s*/,'');
    var verb = {accept:'accepted', reply:'replied to', finish:'finished', note:'added a note to'}[last.type] || 'updated';
    return last.byName+' '+verb+' “'+m.subject+'”';
  }
  function msgAttnCount(){ var me = myMsgId(); return (STATE.messages||[]).filter(function(m){ return m.attn && m.attn[me]; }).length; }
  // Re-render without losing what someone is typing in the reply box.
  function renderKeepMsgDraft(){
    var el = document.getElementById('msgText');
    var had = el && document.activeElement===el;
    if(el) STATE.msgDraft = el.value;
    render();
    if(had){ var n = document.getElementById('msgText'); if(n){ n.focus(); n.selectionStart = n.selectionEnd = n.value.length; } }
  }
  function msgSave(m, patch){
    patch.updatedAt = new Date().toISOString();
    Object.assign(m, patch);
    if(STATE.isLive && STATE.db) return STATE.db.doc('messages/'+m.id).update(patch).catch(function(){ toast('Could not save — check your connection'); });
    render(); return Promise.resolve();
  }
  function clearMsgAttn(m){
    var me = myMsgId(); if(!m.attn || !m.attn[me]) return;
    var attn = Object.assign({}, m.attn); attn[me] = false;
    m.attn = attn;
    if(STATE.isLive && STATE.db) STATE.db.doc('messages/'+m.id).update({attn:attn}).catch(function(){});
  }
  function msgTime(iso){ var d = new Date(iso); if(isNaN(d)) return ''; return fullDate(localIso(d))+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
  function otherSide(m){ return m.fromId===myMsgId() ? m.toId : m.fromId; }

  function openMsgForm(prefillOrderId){
    var o = prefillOrderId ? STATE.orders.find(function(x){ return x.id===prefillOrderId; }) : null;
    STATE.msgForm = {kind:'task', toId:'', subject: o ? ((o.jobNumber||jobNo(o.id))+' — '+(o.title||'')) : '', body:'', dueDate:'', orderId: o ? o.id : '', error:'', busy:false};
    render();
  }
  /* ---- attachments (photos and PDFs, up to 5 per message, 9 MB each) ---- */
  var MSG_MAX_FILES = 5, MSG_MAX_BYTES = 9*1024*1024;
  function msgFileOk(f){ return f && (/^image\/(jpe?g|png|webp|gif)$/i.test(f.type) || f.type==='application/pdf' || /\.(jpe?g|png|pdf)$/i.test(f.name||'')); }
  function addMsgFiles(list, files){
    var bad = 0, big = 0;
    Array.prototype.forEach.call(files||[], function(f){
      if(!msgFileOk(f)){ bad++; return; }
      if(f.size > MSG_MAX_BYTES){ big++; return; }
      if(list.length < MSG_MAX_FILES) list.push(f);
    });
    if(bad) toast('Only photos (JPEG, PNG) and PDFs can be attached');
    else if(big) toast('Files must be under 9 MB');
    else if((files||[]).length && list.length >= MSG_MAX_FILES) toast('Up to '+MSG_MAX_FILES+' files per message');
  }
  function pendingFilesHtml(list, which){
    if(!list || !list.length) return '';
    return '<div class="msg-files pending">' + list.map(function(f, i){
      return '<span class="msg-file"><span class="msg-file-ic">'+(/pdf/i.test(f.type||f.name)?'PDF':'IMG')+'</span>'+escapeHtml(f.name||'file')+' <span class="msg-file-size">'+Math.max(1, Math.round((f.size||0)/1024))+' KB</span><button type="button" class="msg-file-x" data-action="msg-file-remove" data-which="'+which+'" data-i="'+i+'" aria-label="Remove">&times;</button></span>';
    }).join('') + '</div>';
  }
  function attachButton(id, which){
    return '<label class="btn btn-ghost btn-sm msg-attach" title="Attach photos or PDFs"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg> Attach<input type="file" id="'+id+'" data-which="'+which+'" accept="image/jpeg,image/png,image/webp,application/pdf" multiple style="display:none"></label>';
  }
  // Uploads to the same file store as job artwork; resolves to [{url,name,type,size}].
  function uploadMsgFiles(files){
    if(!files || !files.length) return Promise.resolve([]);
    if(!STATE.assets) return Promise.reject({code:'no_assets'});
    var out = [];
    return files.reduce(function(chain, f){
      return chain.then(function(){ return STATE.assets.upload(f).then(function(r){ out.push({url:r.url||r.id, name:f.name||'file', type:f.type||'', size:f.size||0}); }); });
    }, Promise.resolve()).then(function(){ return out; });
  }
  function msgFilesHtml(files, m){
    if(!files || !files.length) return '';
    var canSave = !!(m && m.orderId && !isTechnician() && STATE.orders.some(function(o){ return o.id===m.orderId; }));
    return '<div class="msg-files">' + files.map(function(f){
      var isImg = /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(f.url);
      var save = canSave ? '<button type="button" class="btn btn-ghost btn-sm" data-action="msg-file-save" data-url="'+escapeHtml(f.url)+'" data-order="'+escapeHtml(m.orderId)+'">Save to job</button>' : '';
      if(isImg) return '<span class="msg-file img"><a href="'+escapeHtml(f.url)+'" target="_blank" rel="noopener" title="Open '+escapeHtml(f.name)+'"><img src="'+escapeHtml(f.url)+'" alt="'+escapeHtml(f.name)+'" loading="lazy"></a><span class="msg-file-name">'+escapeHtml(f.name)+'</span>'+save+'</span>';
      return '<span class="msg-file"><span class="msg-file-ic">PDF</span><a href="'+escapeHtml(f.url)+'" target="_blank" rel="noopener">'+escapeHtml(f.name)+'</a>'+save+'</span>';
    }).join('') + '</div>';
  }
  function saveMsgFileToJob(url, orderId){
    var o = STATE.orders.find(function(x){ return x.id===orderId; }); if(!o || isTechnician()) return;
    if((o.attachmentIds||[]).indexOf(url)>=0){ toast('Already on the job'); return; }
    updateOrder(o.id, {attachmentIds:(o.attachmentIds||[]).concat([url])}); toast('Saved to job '+(o.jobNumber||jobNo(o.id)));
  }
  function msgUploadError(err){ return (err && err.code==='no_assets') ? 'File uploads aren’t set up on this device.' : (err && err.code==='too_large') ? 'Files must be under 9 MB.' : 'Couldn’t upload the files — check your connection and try again.'; }

  function captureMsgForm(){
    var f = STATE.msgForm; if(!f) return;
    ['msgKind','msgTo','msgSubject','msgBody','msgDue','msgJob'].forEach(function(id){ var el = document.getElementById(id); if(!el) return; var k = {msgKind:'kind', msgTo:'toId', msgSubject:'subject', msgBody:'body', msgDue:'dueDate', msgJob:'orderId'}[id]; f[k] = el.value; });
  }
  function onMsgFilesChosen(input){
    var which = input.getAttribute('data-which');
    if(which==='new'){ if(!STATE.msgForm) return; captureMsgForm(); STATE.msgForm.files = STATE.msgForm.files || []; addMsgFiles(STATE.msgForm.files, input.files); }
    else { var t = document.getElementById('msgText'); if(t) STATE.msgDraft = t.value; STATE.msgFiles = STATE.msgFiles || []; addMsgFiles(STATE.msgFiles, input.files); }
    input.value = '';
    render();
  }
  function removeMsgFile(which, i){
    if(which==='new'){ if(STATE.msgForm && STATE.msgForm.files){ captureMsgForm(); STATE.msgForm.files.splice(i,1); } }
    else { var t = document.getElementById('msgText'); if(t) STATE.msgDraft = t.value; (STATE.msgFiles||[]).splice(i,1); }
    render();
  }
  function sendNewMsg(){
    var f = STATE.msgForm; if(!f || f.busy) return;
    ['msgKind','msgTo','msgSubject','msgBody','msgDue','msgJob'].forEach(function(id){ var el = document.getElementById(id); if(!el) return; var k = {msgKind:'kind', msgTo:'toId', msgSubject:'subject', msgBody:'body', msgDue:'dueDate', msgJob:'orderId'}[id]; f[k] = el.value; });
    var to = msgPeople().find(function(p){ return p.id===f.toId; });
    if(!to){ f.error = 'Choose who it is for.'; render(); return; }
    if(!String(f.subject).trim()){ f.error = 'Add a short subject.'; render(); return; }
    if(!String(f.body).trim()){ f.error = 'Write the '+(f.kind==='task'?'task':'enquiry')+'.'; render(); return; }
    var now = new Date().toISOString(), me = myMsgId();
    var o = f.orderId ? STATE.orders.find(function(x){ return x.id===f.orderId; }) : null;
    var attn = {}; attn[to.id] = true;
    var rec = {kind:f.kind==='enquiry'?'enquiry':'task', subject:String(f.subject).trim(), body:String(f.body).trim(),
      fromId:me, fromName:myMsgName(), toId:to.id, toName:to.name, createdAt:now, updatedAt:now,
      dueDate: f.kind==='task' ? (f.dueDate||'') : '', orderId: o ? o.id : '', jobNumber: o ? (o.jobNumber||jobNo(o.id)) : '',
      status:'pending', needsAnswer:false, log:[], attn:attn};
    f.busy = true; f.uploading = (f.files||[]).length; render();
    var p = uploadMsgFiles(f.files||[]).then(function(att){
      rec.attachments = att; f.uploading = 0;
      return (STATE.isLive && STATE.db) ? STATE.db.collection('messages').add(rec).then(function(r){ return r.id; })
        : Promise.resolve(uid()).then(function(id){ STATE.messages = [Object.assign({id:id}, rec)].concat(STATE.messages||[]); return id; });
    });
    p.then(function(id){ STATE.msgForm = null; STATE.msgOpenId = id; STATE.msgBox = 'sent'; STATE.tab = 'messages'; render(); toast((rec.kind==='task'?'Task':'Enquiry')+' sent to '+to.name); })
     .catch(function(err){ f.busy = false; f.uploading = 0; f.error = (err && err.code) ? msgUploadError(err) : 'Couldn’t send — check your connection and try again.'; render(); });
  }
  // type: accept | note | reply | finish
  function msgAction(type){
    var m = (STATE.messages||[]).find(function(x){ return x.id===STATE.msgOpenId; }); if(!m) return;
    var me = myMsgId(), isTo = m.toId===me, isFrom = m.fromId===me;
    if(!isTo && !isFrom) return;
    var el = document.getElementById('msgText'), text = String(el ? el.value : (STATE.msgDraft||'')).trim();
    var files = (STATE.msgFiles||[]).slice();
    if(STATE.msgBusy) return;
    if((type==='note' || type==='reply') && !text && !files.length){ toast(type==='note' ? 'Type the note first' : 'Type your reply first'); if(el) el.focus(); return; }
    if(type==='accept' && !(isTo && m.status==='pending')) return;
    if(type==='finish' && !(isTo && m.status==='accepted')){ toast('Accept it first'); return; }
    if(files.length){
      STATE.msgDraft = text; STATE.msgBusy = files.length; render();
      uploadMsgFiles(files).then(function(att){ STATE.msgBusy = 0; STATE.msgFiles = []; msgCommit(m, type, text, att); })
        .catch(function(err){ STATE.msgBusy = 0; render(); toast(msgUploadError(err)); });
      return;
    }
    msgCommit(m, type, text, []);
  }
  function msgCommit(m, type, text, att){
    var me = myMsgId(), isTo = m.toId===me;
    var entry = {at:new Date().toISOString(), byId:me, byName:myMsgName(), type:type, text:text};
    if(att && att.length) entry.files = att;
    var patch = {log:(m.log||[]).concat([entry])};
    var attn = Object.assign({}, m.attn||{});
    var other = otherSide(m);
    if(type==='accept'){ patch.status = 'accepted'; patch.acceptedAt = entry.at; attn[other] = true; }
    if(type==='reply'){ attn[other] = true; patch.needsAnswer = isTo; }
    if(type==='finish'){ patch.status = 'finished'; patch.finishedAt = entry.at; patch.needsAnswer = false; attn[other] = true; }
    if(m.fromId==='system'){ delete attn.system; if(type!=='note' && me!=='owner') attn.owner = true; } // the owner hears how reminders are followed up
    attn[me] = false;
    patch.attn = attn;
    STATE.msgDraft = '';
    msgSave(m, patch).then(function(){
      if(m.fromId==='system'){ toast({accept:'Accepted', note:'Note saved', finish:'Marked finished'}[type] || 'Saved'); return; }
      toast({accept:'Accepted — '+m.fromName+' has been told', note:'Note saved', reply:'Reply sent to '+(isTo?m.fromName:m.toName), finish:'Marked finished — '+m.fromName+' has been told'}[type]);
    });
    render();
  }

  function msgStatusChip(m){
    var me = myMsgId();
    if(m.status==='finished') return '<span class="pay-chip pay-paid">Finished</span>';
    if(m.needsAnswer) return '<span class="pay-chip pay-unpaid">'+(m.fromId===me ? 'Needs your answer' : 'Waiting for answer')+'</span>';
    if(m.status==='accepted') return '<span class="pay-chip pay-part">Accepted</span>';
    return '<span class="pay-chip pay-unpaid">'+(m.toId===me ? 'Accept please' : 'Not accepted yet')+'</span>';
  }
  function msgKindChip(m){ return '<span class="msg-kind msg-'+m.kind+'">'+(m.kind==='task'?'Task':m.kind==='reminder'?'Payment reminder':'Enquiry')+'</span>'; }
  function msgList(){
    var me = myMsgId(), box = STATE.msgBox || 'inbox', open = STATE.msgShow || 'open';
    return (STATE.messages||[]).filter(function(m){
      if(box==='inbox' && m.toId!==me) return false;
      if(box==='sent' && m.fromId!==me) return false;
      if(box==='mine' && m.toId!==me && m.fromId!==me) return false;
      if(open==='open' && m.status==='finished' && !(m.attn && m.attn[me])) return false;
      if(open==='finished' && m.status!=='finished') return false;
      return true;
    });
  }
  function renderMessagesTab(){
    var me = myMsgId(), list = msgList(), box = STATE.msgBox || 'inbox', show = STATE.msgShow || 'open';
    var cnt = function(fn){ return (STATE.messages||[]).filter(fn).length; };
    var inboxN = cnt(function(m){ return m.toId===me && m.attn && m.attn[me]; }), sentN = cnt(function(m){ return m.fromId===me && m.attn && m.attn[me]; });
    var chip = function(k, label, n){ return '<button type="button" class="chip-toggle'+(box===k?' active':'')+'" data-action="msg-box" data-box="'+k+'">'+label+(n?' <span class="msg-dot">'+n+'</span>':'')+'</button>'; };
    var items = list.length ? list.map(function(m){
      var unread = m.attn && m.attn[me];
      var who = m.fromId===me ? ('To '+escapeHtml(m.toName)) : ('From '+escapeHtml(m.fromName));
      var last = (m.log||[]).length ? m.log[m.log.length-1] : null;
      return '<button type="button" class="msg-item'+(STATE.msgOpenId===m.id?' active':'')+(unread?' unread':'')+'" data-action="msg-open" data-id="'+m.id+'">' +
        '<div class="msg-item-top">'+msgKindChip(m)+'<span class="msg-who">'+who+'</span><span class="msg-when">'+relTime(m.updatedAt||m.createdAt)+'</span></div>' +
        '<div class="msg-subj">'+(unread?'<span class="msg-unread-dot"></span>':'')+escapeHtml(m.subject)+'</div>' +
        '<div class="msg-item-foot">'+msgStatusChip(m)+(m.dueDate && m.status!=='finished' ? '<span class="msg-due'+(m.dueDate<todayIso()?' late':'')+'">Due '+shortDate(m.dueDate)+'</span>' : '')+(last ? '<span class="msg-last">'+escapeHtml(last.byName)+': '+escapeHtml(last.type==='accept'?'accepted':last.type==='finish'?'finished':(last.text||'').slice(0,60))+'</span>' : '')+'</div>' +
      '</button>';
    }).join('') : '<div class="empty-note">'+(show==='finished' ? 'Nothing finished here yet.' : (box==='sent' ? 'Nothing you sent is still open.' : 'Nothing waiting for you.'))+'</div>';
    var openMsg = (STATE.messages||[]).find(function(m){ return m.id===STATE.msgOpenId; });
    return '<div class="topline"><div><h1>Messages</h1><div class="sub">Enquiries and ad hoc tasks between team members</div></div>' +
        '<button class="btn btn-primary" data-action="msg-new">+ New enquiry or task</button></div>' +
      '<div class="filterbar" style="margin-bottom:12px;">' + chip('inbox','Received', inboxN) + chip('sent','Sent', sentN) + (isOwnerRole() ? chip('all','Everyone’s', 0) : '') +
        '<span style="width:12px;"></span>' +
        '<button type="button" class="chip-toggle'+(show==='open'?' active':'')+'" data-action="msg-show" data-show="open">Open</button>' +
        '<button type="button" class="chip-toggle'+(show==='finished'?' active':'')+'" data-action="msg-show" data-show="finished">Finished</button>' +
        '<button type="button" class="chip-toggle'+(show==='any'?' active':'')+'" data-action="msg-show" data-show="any">All</button>' +
      '</div>' +
      '<div class="msg-layout'+(openMsg?' has-open':'')+'">' +
        '<div class="msg-list panel">'+items+'</div>' +
        '<div class="msg-detail">'+(openMsg ? renderMsgDetail(openMsg) : '<div class="panel"><div class="empty-note">Choose a message on the left, or send a new enquiry or task.</div></div>')+'</div>' +
      '</div>';
  }
  function renderMsgDetail(m){
    var me = myMsgId(), isTo = m.toId===me, isFrom = m.fromId===me, part = isTo || isFrom;
    var o = m.orderId ? STATE.orders.find(function(x){ return x.id===m.orderId; }) : null;
    var LOG_LABEL = {accept:'accepted', note:'note', reply:'reply', finish:'finished', system:'reminder'};
    var log = (m.log||[]).map(function(e){
      var mine = e.byId===me;
      return '<div class="msg-entry msg-'+e.type+(mine?' mine':'')+'">' +
        '<div class="msg-entry-head"><strong>'+escapeHtml(e.byName)+'</strong> <span class="msg-tag">'+LOG_LABEL[e.type]+'</span><span class="msg-when">'+msgTime(e.at)+'</span></div>' +
        (e.text ? '<div class="msg-entry-text">'+escapeHtml(e.text).replace(/\n/g,'<br>')+'</div>' : '') +
        msgFilesHtml(e.files, m) +
      '</div>';
    }).join('');
    var draft = escapeHtml(STATE.msgDraft||'');
    var actions = '';
    if(part && m.status!=='finished'){
      var ph = m.fromId==='system' ? 'What did the customer say? Keep notes on your follow-up here…' : isTo ? (m.status==='pending' ? 'Need more information before you accept? Type your question and press “Reply to '+escapeHtml(m.fromName)+'”.' : 'Notes on your progress, or a question for '+escapeHtml(m.fromName)+'…')
                    : 'Answer '+escapeHtml(m.toName)+'’s question, add more detail, or keep a note…';
      actions = '<div class="msg-compose">' +
        '<textarea id="msgText" rows="3" placeholder="'+ph+'">'+draft+'</textarea>' +
        pendingFilesHtml(STATE.msgFiles, 'reply') +
        (STATE.msgBusy ? '<div class="hint">Uploading '+STATE.msgBusy+' file'+(STATE.msgBusy===1?'':'s')+'…</div>' : '') +
        '<div class="msg-buttons">' + attachButton('msgReplyFiles', 'reply') +
          (isTo && m.status==='pending' ? '<button class="btn btn-primary btn-sm" data-action="msg-act" data-type="accept">Accept</button>' : '') +
          '<button class="btn btn-sm" data-action="msg-act" data-type="note" title="Saved on this '+(m.kind==='task'?'task':'enquiry')+' — no notification">Save note</button>' +
          (m.fromId==='system' ? '' : '<button class="btn btn-sm" data-action="msg-act" data-type="reply">'+(isTo ? 'Reply to '+escapeHtml(m.fromName) : 'Send reply to '+escapeHtml(m.toName))+'</button>') +
          (isTo && m.status==='accepted' ? '<button class="btn btn-primary btn-sm" data-action="msg-act" data-type="finish">Finish</button>' : '') +
        '</div>' +
        '<div class="hint">'+(m.fromId==='system' ? 'Accept it, keep notes on your follow-up, and press Finish once the customer has paid or it is sorted. The owner sees when you accept and finish.' : isTo ? (m.status==='pending' ? 'You need to accept this before you can finish it.' : '“Finish” closes it and lets '+escapeHtml(m.fromName)+' know. Anything typed in the box is sent with it.') : 'Replies notify '+escapeHtml(m.toName)+'. Notes are saved without a notification.')+'</div>' +
      '</div>';
    } else if(m.status==='finished'){
      actions = '<div class="hint" style="margin-top:10px;">Finished by '+escapeHtml(m.toName)+(m.finishedAt?(' on '+msgTime(m.finishedAt)):'')+'.</div>';
    } else {
      actions = '<div class="hint" style="margin-top:10px;">You can see this because you are the owner. Only '+escapeHtml(m.fromName)+' and '+escapeHtml(m.toName)+' can act on it.</div>';
    }
    return '<div class="panel msg-thread">' +
      '<div class="msg-thread-head"><div>'+msgKindChip(m)+' '+msgStatusChip(m)+'<h2>'+escapeHtml(m.subject)+'</h2>' +
        '<div class="hint" style="margin:2px 0 0;">From <strong>'+escapeHtml(m.fromName)+'</strong> to <strong>'+escapeHtml(m.toName)+'</strong> &middot; '+msgTime(m.createdAt) +
        (m.dueDate ? ' &middot; <span class="msg-due'+(m.dueDate<todayIso() && m.status!=='finished'?' late':'')+'">Due '+fullDate(m.dueDate)+'</span>' : '') + '</div>' +
        (m.orderId ? '<div style="margin-top:6px;"><button type="button" class="btn btn-ghost btn-sm" data-action="open-order" data-id="'+escapeHtml(m.orderId)+'"'+(o?'':' disabled')+'>Job '+escapeHtml(m.jobNumber||'')+(o?' — '+escapeHtml(o.title||''):' (not found)')+'</button></div>' : '') +
      '</div><button class="modal-close" data-action="msg-close" aria-label="Close">&times;</button></div>' +
      '<div class="msg-entry msg-original"><div class="msg-entry-text">'+escapeHtml(m.body).replace(/\n/g,'<br>')+'</div>'+msgFilesHtml(m.attachments, m)+'</div>' +
      log + actions +
    '</div>';
  }
  function renderMsgForm(){
    var f = STATE.msgForm; if(!f) return '';
    var people = msgPeople();
    var jobs = STATE.orders.filter(function(o){ return !o.quoteOnly && o.status!=='collected'; }).slice(0, 200);
    return '<div class="overlay" data-action="close-modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="New enquiry or task" style="max-width:560px;">' +
      '<div class="modal-head"><div><h2>New enquiry or task</h2></div><button class="modal-close" data-action="msg-form-close" aria-label="Close">&times;</button></div>' +
      (f.error ? '<div class="field-error" style="margin-bottom:8px;">'+escapeHtml(f.error)+'</div>' : '') +
      '<div class="field-row">' +
        '<div class="field"><label for="msgKind">Type</label><select id="msgKind"><option value="task"'+(f.kind==='task'?' selected':'')+'>Task — something to do</option><option value="enquiry"'+(f.kind==='enquiry'?' selected':'')+'>General enquiry — a question</option></select></div>' +
        '<div class="field"><label for="msgTo">For</label><select id="msgTo"><option value="">Choose a team member</option>' + people.map(function(p){ return '<option value="'+p.id+'"'+(f.toId===p.id?' selected':'')+'>'+escapeHtml(p.name)+' ('+escapeHtml(p.role)+')</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field"><label for="msgSubject">Subject</label><input type="text" id="msgSubject" maxlength="120" value="'+escapeHtml(f.subject)+'" placeholder="e.g. Collect vinyl from supplier"></div>' +
      '<div class="field"><label for="msgBody">Details</label><textarea id="msgBody" rows="5" placeholder="What needs to be done, or what you want to know">'+escapeHtml(f.body)+'</textarea></div>' +
      '<div class="field-row">' +
        '<div class="field" id="msgDueWrap"'+(f.kind==='task'?'':' style="display:none;"')+'><label for="msgDue">Due date (optional)</label><input type="date" id="msgDue" value="'+escapeHtml(f.dueDate)+'"></div>' +
        '<div class="field"><label for="msgJob">About a job (optional)</label><select id="msgJob"><option value="">Not about a job</option>' + jobs.map(function(o){ return '<option value="'+o.id+'"'+(f.orderId===o.id?' selected':'')+'>'+escapeHtml((o.jobNumber||jobNo(o.id))+' — '+(o.title||'')+' ('+(o.customerName||'')+')')+'</option>'; }).join('') + '</select></div>' +
      '</div>' +
      '<div class="field" style="margin-top:-4px;">' + attachButton('msgNewFiles', 'new') + '<span class="hint" style="margin-left:8px;">Photos or PDFs, up to 5 files of 9 MB each</span>' + pendingFilesHtml(f.files, 'new') + '</div>' +
      '<div class="modal-foot"><button class="btn btn-ghost" data-action="msg-form-close">Cancel</button><button class="btn btn-primary" data-action="msg-send"'+(f.busy?' disabled':'')+'>'+(f.busy?(f.uploading?'Uploading '+f.uploading+' file'+(f.uploading===1?'':'s')+'…':'Sending…'):'Send')+'</button></div>' +
    '</div></div>';
  }

  /* ============================ order date, reminders settings, commission PDF (update 25) ============================ */
  function orderDateOf(o){ return String(o.orderDate || o.createdAt || '').slice(0,10); }

  function renderReminderPanel(){
    var on = STATE.config.paymentReminders !== false, every = Number(STATE.config.reminderEveryDays)||7;
    return '<div class="panel">' +
      '<div class="section-label">Payment reminders</div>' +
      '<div class="hint" style="margin:-4px 0 12px;">Every weekday at 07:30 the system checks for invoices that are past their due date and not fully paid (after receipts and credit notes). The job’s designer gets a <strong>Payment reminder</strong> in Messages to follow up with the customer; jobs without a designer go to you. While an invoice stays unpaid the reminder repeats.</div>' +
      '<label style="display:flex; gap:8px; align-items:center; margin-bottom:10px; cursor:pointer;"><input type="checkbox" id="cfgRemOn" style="width:auto;"'+(on?' checked':'')+'> Send payment reminders automatically</label>' +
      '<div class="field"><label for="cfgRemEvery">Repeat every (days) while unpaid</label><input type="number" id="cfgRemEvery" min="1" max="60" style="max-width:110px;" value="'+every+'"></div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap;">' +
        '<button class="btn btn-primary btn-sm" data-action="save-reminders">Save</button>' +
        '<button class="btn btn-sm" data-action="send-reminders-now"'+(STATE.remBusy?' disabled':'')+'>'+(STATE.remBusy?'Checking…':'Send reminders now')+'</button>' +
      '</div>' +
    '</div>';
  }
  function saveReminderSettings(){
    if(!isOwnerRole()) return;
    var patch = {paymentReminders: !!document.getElementById('cfgRemOn').checked, reminderEveryDays: Math.min(60, Math.max(1, parseInt(document.getElementById('cfgRemEvery').value,10)||7))};
    STATE.config = Object.assign({}, STATE.config, patch);
    if(STATE.isLive && STATE.db){ STATE.db.doc('config/business').merge(patch).then(function(){ toast('Reminder settings saved'); }).catch(function(){ toast('Could not save — try again'); }); }
    else { toast('Reminder settings saved'); render(); }
  }
  function sendRemindersNow(){
    if(!isOwnerRole() || STATE.remBusy) return;
    if(!(window.DSX && window.DSX.call)){ toast('Reminders need the live app'); return; }
    STATE.remBusy = true; render();
    window.DSX.call('sendPaymentReminders', {}).then(function(r){
      var d = (r && r.data) || r || {}; STATE.remBusy = false; render();
      var n = (d.sent||0) + (d.updated||0);
      toast(n ? (n+' reminder'+(n===1?'':'s')+' sent to Messages') : 'No reminders due today — overdue invoices were already reminded recently, or nothing is overdue');
    }).catch(function(e){ STATE.remBusy = false; render(); toast((e && /not.found|NOT_FOUND|internal/i.test(String(e.code||e.message))) ? 'Deploy the functions first (firebase deploy --only functions)' : 'Could not send reminders — try again'); });
  }

  function commissionReportPdf(){
    if(!window.jspdf || !window.jspdf.jsPDF){ toast('PDF tools are still loading — try again in a moment'); return; }
    var range = reportRange(), data = commissionRows(range);
    var ownerView = isOwnerRole(), me = currentTeamMember();
    var rows = ownerView ? data.rows : data.rows.filter(function(r){ return me && r.member.id===me.id; });
    rows = rows.slice().sort(function(a,b){ return b.total - a.total || String(a.member.name).localeCompare(b.member.name); });
    var doc = new window.jspdf.jsPDF({unit:'mm', format:'a4'});
    var L = 15, R = 195, MAROON = [78,9,40];
    var y = 0;
    function head(){
      try { doc.addImage(LOGO_PDF_DATA_URL, 'PNG', L, 10, 40, 40*(358/800)); } catch(e){}
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text(lh('docCompanyName'), R, 15, {align:'right'});
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(95,99,88); doc.text(lh('docAddress'), R, 19.5, {align:'right'});
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, 30, R-L, 0.7, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(15); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text('COMMISSION REPORT', L, 39);
      doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(60,60,60);
      doc.text(rangeLabel(range)+(ownerView?'':'  ·  '+(me?me.name:''))+'   ·   Generated '+fullDate(todayIso()), L, 44.5);
      y = 51;
    }
    function bar(cols){
      doc.setFillColor(MAROON[0],MAROON[1],MAROON[2]); doc.rect(L, y, R-L, 7.5, 'F');
      doc.setFont('helvetica','bold'); doc.setFontSize(7.3); doc.setTextColor(255,255,255);
      cols.forEach(function(c){ doc.text(c[0], c[1], y+5, c[2]==='r'?{align:'right'}:{}); });
      y += 7.5;
    }
    function need(h, cols){ if(y + h > 280){ doc.addPage(); head(); if(cols) bar(cols); } }
    head();
    // summary
    var SC = [['TEAM MEMBER',L+1,'l'],['ROLE',L+52,'l'],['JOBS',L+98,'r'],['SALES EXCL. VAT',L+135,'r'],['RATE',L+152,'r'],['COMMISSION',R-1,'r']];
    bar(SC);
    var tSales = 0, tComm = 0, tJobs = 0;
    rows.forEach(function(r, i){
      need(7, SC);
      if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, 7, 'F'); }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.6); doc.setTextColor(43,43,43);
      doc.setFont('helvetica','bold'); doc.text(String(r.member.name), SC[0][1], y+4.8); doc.setFont('helvetica','normal');
      doc.text(roleLabel(r.member.role)||'', SC[1][1], y+4.8);
      doc.text(String(r.jobs.length), SC[2][1], y+4.8, {align:'right'});
      doc.text(pdfNum(r.total), SC[3][1], y+4.8, {align:'right'});
      doc.text(fmtRate(r.rate), SC[4][1], y+4.8, {align:'right'});
      doc.setFont('helvetica','bold'); doc.text(pdfNum(r.commission), SC[5][1], y+4.8, {align:'right'});
      tSales += r.total; tComm += r.commission; tJobs += r.jobs.length; y += 7;
    });
    if(ownerView){
      need(10, SC);
      doc.setDrawColor(MAROON[0],MAROON[1],MAROON[2]); doc.setLineWidth(0.4); doc.line(L, y+0.5, R, y+0.5);
      doc.setFont('helvetica','bold'); doc.setFontSize(8.6); doc.setTextColor(43,43,43);
      doc.text('TOTAL COMMISSION PAYABLE', SC[0][1], y+5.5); doc.text(pdfNum(round2(tComm)), SC[5][1], y+5.5, {align:'right'});
      y += 9;
      doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(95,99,88);
      doc.text('Invoiced sales in the period: '+money(data.salesTotal)+' excl. VAT ('+data.salesCount+' job'+(data.salesCount===1?'':'s')+').'+(data.unassignedCount ? '  Unassigned: '+money(data.unassignedTotal)+' ('+data.unassignedCount+'), not counted.' : ''), L, y+2);
      y += 6;
    }
    // per person
    var DC = [['INVOICE',L+1,'l'],['DATE',L+30,'l'],['CUSTOMER',L+52,'l'],['JOB',L+100,'l'],['SHARE',L+152,'r'],['SALES CREDITED',R-1,'r']];
    rows.filter(function(r){ return r.jobs.length; }).forEach(function(r){
      y += 5; need(30);
      doc.setFont('helvetica','bold'); doc.setFontSize(10.5); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]);
      doc.text(r.member.name+'  ·  '+roleLabel(r.member.role), L, y+3);
      doc.setFont('helvetica','normal'); doc.setFontSize(8.3); doc.setTextColor(95,99,88);
      doc.text(money(r.total)+' excl. VAT  ·  rate '+fmtRate(r.rate)+'  ·  commission '+money(r.commission), R, y+3, {align:'right'});
      y += 6; bar(DC);
      r.jobs.slice().sort(function(a,b){ return String(saleDate(a)).localeCompare(String(saleDate(b))); }).forEach(function(o, i){
        need(6.5, DC);
        if(i%2===1){ doc.setFillColor(246,245,241); doc.rect(L, y, R-L, 6.5, 'F'); }
        var share = creditShare(o, r.member.id);
        doc.setFont('helvetica','normal'); doc.setFontSize(7.9); doc.setTextColor(43,43,43);
        doc.text(String(o.invoiceNumber||jobNo(o.id)), DC[0][1], y+4.4);
        doc.text(fullDate(String(saleDate(o)).slice(0,10)), DC[1][1], y+4.4);
        doc.text(doc.splitTextToSize(String(o.customerName||''), 46)[0]||'', DC[2][1], y+4.4);
        doc.text(doc.splitTextToSize(String(o.title||''), 50)[0]||'', DC[3][1], y+4.4);
        doc.text(share===1?'100%':(Math.round(share*100)+'%'), DC[4][1], y+4.4, {align:'right'});
        doc.text(pdfNum(round2(saleExVat(o)*share)), DC[5][1], y+4.4, {align:'right'});
        y += 6.5;
      });
    });
    // tiers
    y += 6; need(48);
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(MAROON[0],MAROON[1],MAROON[2]); doc.text('COMMISSION SCALE', L, y+3); y += 6;
    doc.setFont('helvetica','normal'); doc.setFontSize(8); doc.setTextColor(60,60,60);
    COMMISSION_TIERS.forEach(function(t){ doc.text(tierLabel(t).replace(/R\s/g,'R '), L+2, y+3); doc.text(fmtRate(t.rate), L+80, y+3, {align:'right'}); y += 4.6; });
    doc.setFontSize(7.6); doc.setTextColor(95,99,88);
    doc.text('Sales are invoiced amounts excl. VAT, after credit notes. The rate for a person’s total applies to the whole total. Two technicians on a job share it 50/50.', L, y+3, {maxWidth:R-L});
    var name = 'DsignX-commission-'+(rangeIsMonth(range)||((range.from||'start')+'_to_'+(range.to||todayIso())))+(ownerView?'':'-'+String(me?me.name:'').replace(/\W+/g,''))+'.pdf';
    var blob = doc.output('blob');
    if(STATE.downloads){ STATE.downloads.save({filename:name, data:blob}).catch(function(){ fallbackDownload(blob, name); }); } else fallbackDownload(blob, name);
  }

  /* ============================ boot ============================ */
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
