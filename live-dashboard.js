/* GIMMDA dashboard · authentication gate and live wiring
   Loads after the dashboard script; overrides sample handlers with Supabase-backed ones. */
(function () {
  const ui = window.GIMMDA;
  const { live, sb, dash, escHtml: esc, peso, phToday, phDateTime, fmtDay, chTime, initials, planLabel, friendly } = ui;

  /* ---- Tier 3 ops: error reporting, offline queue, upload checks --------- */
  // 1. Report crashes to the owner instead of losing them in the console.
  (function reportErrors() {
    let sent = 0;
    const send = (message, stack, context) => {
      if (sent > 20) return; // never let reporting itself become the problem
      sent++;
      try {
        // Goes through an RPC so the table can't be flooded; the function caps at 20/hour.
        let key = '';
        try { key = localStorage.getItem('gimmda-reporter') || ''; } catch (error) { /* private mode */ }
        if (!key) { key = 'r-' + Math.random().toString(36).slice(2, 12); try { localStorage.setItem('gimmda-reporter', key); } catch (error) { /* ignore */ } }
        sb.rpc('report_client_error', {
          p_message: String(message),
          p_stack: String(stack || ''),
          p_url: location.href,
          p_agent: navigator.userAgent,
          p_reporter: key
        }).then(() => {}, () => {});
      } catch (failure) { /* ignore */ }
    };
    window.addEventListener('error', event => {
      if (event?.message && !/ResizeObserver/.test(event.message)) send(event.message, event.error?.stack, { kind: 'error' });
    });
    window.addEventListener('unhandledrejection', event => {
      const reason = event?.reason;
      send(reason?.message || 'Unhandled promise rejection', reason?.stack, { kind: 'promise' });
    });
    window.GIMMDAreport = send;
  })();

  // 2. Offline queue: if the connection drops mid-action, the attempt is kept and
  //    replayed when it comes back, so staff never lose a payment to a dead signal.
  const QUEUE_KEY = 'gimmda-offline-queue';
  const readQueue = () => {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (error) { return []; }
  };
  const writeQueue = rows => {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(rows)); } catch (error) { /* storage full */ }
  };
  function queueAction(fn, args) {
    const rows = readQueue();
    rows.push({ fn, args, at: new Date().toISOString() });
    writeQueue(rows);
  }
  async function flushQueue() {
    const rows = readQueue();
    if (!rows.length) return 0;
    const remaining = [];
    let done = 0;
    for (const row of rows) {
      try { await sb.rpc(row.fn, row.args); done++; }
      catch (failure) { remaining.push(row); }
    }
    writeQueue(remaining);
    if (done) {
      toastLive(`${done} queued action${done === 1 ? '' : 's'} sent.`);
      await refreshData(true);
    }
    return done;
  }
  window.addEventListener('online', () => { flushQueue(); });
  window.addEventListener('offline', () => { toastLive('You are offline. Actions will be queued until the connection returns.'); });
  // Try once shortly after load in case something was left behind.
  setTimeout(() => { if (navigator.onLine && readQueue().length) flushQueue(); }, 4000);
  window.GIMMDAqueue = { queueAction, flushQueue, readQueue };

  function offlineBanner() {
    if (!navigator.onLine) { toastLive('You are offline — actions will be queued.'); return true; }
    return false;
  }

  // 3. Upload validation that runs before anything reaches storage.
  const SAFE_IMAGE = ['image/jpeg', 'image/png', 'image/webp'];
  async function validateImage(file, maxBytes = 2 * 1024 * 1024) {
    if (!file) throw new Error('No file chosen.');
    if (!SAFE_IMAGE.includes(file.type)) throw new Error('Only JPG, PNG or WebP images are allowed.');
    if (file.size > maxBytes) throw new Error(`That image is ${(file.size / 1048576).toFixed(1)} MB — the limit is ${(maxBytes / 1048576).toFixed(0)} MB.`);
    // A renamed .exe would still carry an image MIME claim, so check the magic bytes too.
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const isJpeg = head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF;
    const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
    const isWebp = head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) throw new Error('That file is not a real image.');
    return true;
  }
  window.GIMMDAvalidateImage = validateImage;

  const loginScreen = document.querySelector('#login-screen');
  const loginForm = document.querySelector('#login-form');
  const emailInput = document.querySelector('#email');
  const passwordInput = document.querySelector('#password');
  const loginButton = loginForm.querySelector('.login-submit');
  const loginNote = loginForm.querySelector('.login-note');
  const ownerShell = document.querySelector('.shell:not(#staff-shell)');
  const staffShell = document.querySelector('#staff-shell');
  const ownerContent = ownerShell.querySelector('.content');
  const staffContent = document.querySelector('#staff-content');
  const signOutButton = document.querySelector('#signout');
  const staffSignOut = document.querySelector('#staff-signout');
  const signOut = async () => {
    await sb.auth.signOut();
    loginScreen.hidden = false;
    ownerShell.hidden = true;
    staffShell.hidden = true;
    live.ready = false;
    live.profile = null;
    currentRole = null;
    passwordInput.value = '';
    busy(false);
    setNote('You have been signed out.');
  };
  signOutButton?.addEventListener('click', signOut);
  staffSignOut?.addEventListener('click', signOut);

  /* Account menu + toolbar controls (the sample app used to wire these) */
  const profileButton = document.querySelector('#profile-button');
  profileButton?.addEventListener('click', () => {
    if (!signOutButton) return;
    signOutButton.hidden = !signOutButton.hidden;
    profileButton.setAttribute('aria-expanded', String(!signOutButton.hidden));
  });
  document.querySelectorAll('.motion-control').forEach(button => {
    button.addEventListener('click', () => {
      const on = button.getAttribute('aria-pressed') !== 'true';
      document.querySelectorAll('.motion-control').forEach(item => {
        item.textContent = on ? '✳ Motion on' : '✳ Motion off';
        item.setAttribute('aria-pressed', String(on));
      });
      document.body.classList.toggle('motion-demo-enabled', on);
    });
  });
  document.querySelector('.topright .iconbtn[title="Settings"]')?.addEventListener('click', () => {
    const settings = [...ownerNav.querySelectorAll('button')].find(item => item.textContent.trim() === 'Settings');
    settings?.click();
  });
  document.querySelector('.topright .iconbtn[title="Notifications"]')?.addEventListener('click', () => {
    const items = live.activity.slice(0, 10);
    dialog({ title: 'Gym notifications', body: items.length ? items.map(a => `<strong>${esc(a.summary)}</strong><br><span style="color:#8b9a8d">${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</span>`).join('<hr style="border:0;border-top:1px solid #eef2ec;margin:11px 0">') : 'No activity recorded yet.', action: 'Close' });
  });
  const searchBox = document.querySelector('.searchbox');
  const searchButton = document.querySelector('#search');
  searchButton?.addEventListener('click', () => {
    searchBox?.classList.toggle('show');
    searchBox?.focus();
  });
  searchBox?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const query = searchBox.value.trim();
    if (!query) return;
    const membersTab = [...ownerNav.querySelectorAll('button')].find(item => item.textContent.trim() === 'Members');
    membersTab?.click();
    setTimeout(() => {
      const field = ownerContent.querySelector('#owner-search');
      if (!field) return;
      field.value = query;
      field.dispatchEvent(new Event('input'));
    }, 120);
  });

  let currentRole = null;

  const setNote = (text, tone) => {
    loginNote.textContent = text;
    loginNote.style.color = tone === 'error' ? '#a6453b' : tone === 'ok' ? '#3f6b45' : '';
  };
  const busy = (on, label) => {
    loginButton.disabled = on;
    loginButton.textContent = on ? 'Signing in…' : (label || 'Sign in to dashboard ↗');
  };

  /* First-run setup: if the gym has no owner yet, the first signed-in account becomes owner. */
  let setupNeeded = false;
  let setupLink = null;
  (function prepareSetupLink() {
    setupLink = document.createElement('p');
    setupLink.className = 'login-note';
    setupLink.hidden = true;
    setupLink.innerHTML = 'Setting up this gym for the first time? <a href="#" id="first-run" style="color:#33583c;font-weight:700;text-decoration:underline">Create the owner account</a>';
    loginNote.after(setupLink);
    setupLink.querySelector('#first-run').addEventListener('click', event => {
      event.preventDefault();
      loginForm.hidden = true;
      const setup = document.createElement('form');
      setup.className = 'login-form';
      setup.id = 'setup-form';
      setup.innerHTML = `<h1>Set up your gym.</h1><p class="intro-text">This creates the first owner account for GIMMDA | Hill Fitness Gym. It only works once.</p>
        <label class="field" for="setup-name">Your full name</label><input class="login-input" id="setup-name" required maxlength="100" autocomplete="name">
        <label class="field" for="setup-email">Email address</label><input class="login-input" id="setup-email" type="email" required autocomplete="email">
        <label class="field" for="setup-password">Password</label><input class="login-input" id="setup-password" type="password" required minlength="8" autocomplete="new-password">
        <button class="login-submit" type="submit" style="margin-top:22px">Create owner account &nbsp; ↗</button>
        <p class="login-note setup-message" role="status">Use an email you control. Staff and member accounts are added later from inside the dashboard.</p>
        <button type="button" class="outline setup-back" style="margin-top:12px;width:100%">Back to sign in</button>`;
      loginForm.after(setup);
      setup.querySelector('.setup-back').onclick = () => { setup.remove(); loginForm.hidden = false; };
      setup.onsubmit = async submitEvent => {
        submitEvent.preventDefault();
        const message = setup.querySelector('.setup-message');
        const button = setup.querySelector('.login-submit');
        button.disabled = true;
        message.textContent = 'Creating your owner account…';
        // Wrapped in try/catch by the caller so a rejected sign-up can never block the login screen.
        const { data, error } = await ui.signUpFirstOwner(
          setup.querySelector('#setup-email').value.trim(),
          setup.querySelector('#setup-password').value,
          setup.querySelector('#setup-name').value.trim()
        ).catch(failure => ({ data: null, error: failure }));
        if (error) {
          button.disabled = false;
          message.textContent = /signups not allowed/i.test(error.message || '')
            ? 'Account creation is closed. Ask the gym owner to create your account in Supabase, then sign in.'
            : friendly(error);
          return;
        }
        if (!data.session) {
          button.disabled = false;
          message.textContent = 'Check your email to confirm the account, then sign in.';
          return;
        }
        try {
          await ui.call('bootstrap_owner', {});
          setup.remove();
          loginForm.hidden = false;
          await startSession(data.session);
        } catch (failure) {
          button.disabled = false;
          message.textContent = friendly(failure);
        }
      };
      setup.querySelector('#setup-name').focus();
    });
  })();

  // "Forgot password?" — asks Supabase to email a recovery link. Works the moment
  // an SMTP sender is configured; until then the request is accepted but no mail
  // leaves, so the copy tells people to ask the owner instead.
  const forgotLink = document.createElement('button');
  forgotLink.type = 'button';
  forgotLink.textContent = 'Forgot your password?';
  forgotLink.style.cssText = 'display:block;margin:14px auto 0;border:0;background:none;color:#6c846b;font:600 11px "DM Sans",sans-serif;cursor:pointer;text-decoration:underline';
  const firstLoginNote = loginForm.querySelector('.login-note');
  if (firstLoginNote) loginForm.insertBefore(forgotLink, firstLoginNote); else loginForm.append(forgotLink);

  forgotLink.addEventListener('click', () => {
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<form class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">ACCOUNT HELP</div><h2>Reset your password</h2><p>We'll email you a secure link to set a new password.</p></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <label class="field">Email address on your account</label><input class="login-input" id="forgot-email" type="email" autocomplete="username" required value="${esc(emailInput.value.trim())}">
      <p class="login-note forgot-note" role="status" style="text-align:left"></p>
      <div class="renew-actions"><button type="button" class="outline act-cancel">Cancel</button><button class="login-submit" type="submit">Send reset link</button></div>
      <p class="renew-hint">No email yet? Ask the owner to issue a temporary password from the Staff page.</p></form>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('.act-cancel').onclick = close;
    box.addEventListener('cancel', event => { event.preventDefault(); close(); });
    const note = box.querySelector('.forgot-note');
    box.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const field = box.querySelector('#forgot-email');
      const address = field.value.trim();
      // Show our own message instead of relying on the browser's native tooltip,
      // which is invisible on some devices and in screenshots.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
        note.style.color = '#a05a5a';
        note.textContent = 'Enter a valid email address, e.g. name@yourgym.com';
        field.focus();
        return;
      }
      const button = box.querySelector('.login-submit');
      button.disabled = true;
      note.style.color = '#6c846b';
      note.textContent = 'Sending…';
      try {
        const { error } = await sb.auth.resetPasswordForEmail(address, {
          redirectTo: window.location.origin + window.location.pathname,
        });
        if (error) {
          note.style.color = '#a05a5a';
          note.textContent = /invalid/i.test(error.message)
            ? 'That email address looks invalid. Ask the owner to check what is on your account.'
            : friendly(error);
          button.disabled = false;
          return;
        }
        note.style.color = '#4d7a4d';
        note.innerHTML = 'If that address has an account, a reset link is on its way. Check spam too.<br><br><b>Nothing arrived?</b> Ask the owner for a temporary password.';
      } catch (failure) {
        note.style.color = '#a05a5a';
        note.textContent = friendly(failure);
        button.disabled = false;
      }
    };
    box.showModal();
    box.querySelector('#forgot-email').focus();
  });

  // Supabase sends people back here with a recovery token in the URL.
  // Detect it, then let them set a new password without needing the old one.
  const recoveryInUrl = /type=recovery|access_token=/.test(window.location.hash + window.location.search);
  if (recoveryInUrl && sb.auth) {
    // supabase-js parses the URL token asynchronously. getSession() can resolve with
    // no session if we ask too early, so listen for the auth event first and only
    // fall back to a direct check.
    const openRecovery = (session) => {
      if (!session) return;
      const panel = document.createElement('section');
      panel.className = 'login-screen';
      panel.innerHTML = `<div class="login-art"><div class="brand"><img class="brandmark" src="hill-logo-monochrome.png" alt=""><span class="product-brand-name">GIMMDA</span><span class="branding-divider" aria-hidden="true"></span><span class="gym-brand-name">HILL FITNESS GYM</span></div><div class="login-art-copy"><div class="eyebrow">ACCOUNT RECOVERY</div><h2>Back to<br>your <em>gym.</em></h2><p>Your reset link is valid. Choose a new password and you're straight back in.</p></div></div>
        <div class="login-side"><form class="login-form" id="recover-form"><h1>Set a new password.</h1><p class="intro-text">At least 10 characters.</p>
        <label class="field" for="rec-pw">New password</label><input class="login-input" id="rec-pw" type="password" minlength="10" autocomplete="new-password" required>
        <label class="field" for="rec-pw2">Repeat new password</label><input class="login-input" id="rec-pw2" type="password" minlength="10" autocomplete="new-password" required>
        <div style="height:22px"></div><button class="login-submit" type="submit">Save password &amp; sign in &nbsp; ↗</button>
        <p class="login-note rec-note" role="status"></p></form></div>`;
      loginScreen.hidden = true;
      document.body.prepend(panel);
      history.replaceState(null, '', window.location.pathname);
      const note = panel.querySelector('.rec-note');
      panel.querySelector('#recover-form').onsubmit = async event => {
        event.preventDefault();
        const first = panel.querySelector('#rec-pw').value;
        const second = panel.querySelector('#rec-pw2').value;
        if (first.length < 10) { note.textContent = 'Use at least 10 characters.'; return; }
        if (first !== second) { note.textContent = 'The two passwords do not match.'; return; }
        const button = panel.querySelector('.login-submit');
        button.disabled = true;
        note.textContent = 'Saving…';
        try {
          await ui.call('change_own_password', { p_new_password: first });
          const { data: fresh } = await sb.auth.getSession();
          panel.remove();
          await startSession(fresh.session);
        } catch (failure) {
          button.disabled = false;
          note.textContent = friendly(failure);
        }
      };
    };

    // Parse the tokens ourselves and hand them to the SDK explicitly. Relying on
    // detectSessionInUrl alone leaves the screen blank if the hash is dropped or the
    // SDK parses before this script runs.
    const params = new URLSearchParams(
      (window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '') || window.location.search.slice(1)
    );
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    let opened = false;
    const claim = async () => {
      if (opened) return;
      opened = true;
      try {
        if (accessToken && refreshToken) await sb.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        const { data } = await sb.auth.getSession();
        if (data?.session) openRecovery(data.session);
        else opened = false;
      } catch (failure) { opened = false; }
    };
    sb.auth.onAuthStateChange((event, session) => {
      if (session && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) {
        if (!opened) { opened = true; openRecovery(session); }
      }
    });
    claim();
    setTimeout(claim, 900);
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) return setNote('Enter your email and password.', 'error');
    busy(true);
    setNote('Checking your account…');
    // Refuse to keep trying passwords once there have been too many failures for
    // this address, which is what stops an automated guessing attack.
    try {
      const { data: throttle } = await sb.rpc('login_throttle_status', { p_email: email });
      if (throttle && throttle.allowed === false) {
        busy(false);
        return setNote(`Too many failed attempts. Try again in ${throttle.retry_after_minutes} minutes, or ask the gym owner to reset your password.`, 'error');
      }
    } catch (failure) { /* never block a sign-in because the check itself failed */ }
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    try { await sb.rpc('record_login_attempt', { p_email: email, p_succeeded: !error }); } catch (failure) { /* logging a failed attempt must never block sign-in */ }
    if (error) {
      const message = /invalid login credentials/i.test(error.message)
        ? 'That email and password don’t match an account. Ask the gym for help.'
        : /email not confirmed/i.test(error.message)
          ? 'Confirm your email address before signing in.'
          : friendly(error);
      busy(false);
      setNote(message, 'error');
      return;
    }
    passwordInput.value = '';
    await startSession(data.session);
  });

  async function startSession(session) {
    live.session = session;
    if (!session) {
      showLogin();
      return;
    }
    const { data: profile, error } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error || !profile) {
      await sb.auth.signOut();
      busy(false);
      setNote('This account has no gym profile yet. Ask the owner to finish setup.', 'error');
      return;
    }
    if (!profile.is_active) {
      await sb.auth.signOut();
      busy(false);
      setNote('This account has been deactivated. Contact the gym owner.', 'error');
      return;
    }
    if (profile.role === 'member') {
      await sb.auth.signOut();
      busy(false);
      setNote('This account is waiting for the owner to assign access. Ask the owner to set your role on the Staff page.', 'error');
      return;
    }
    if (profile.must_change_password) {
      live.profile = profile;
      live.session = session;
      busy(false);
      showForcedPasswordChange();
      return;
    }
    live.profile = profile;
    live.ready = true;
    try {
      await ui.loadAll();
    } catch (failure) {
      console.warn('GIMMDA load', failure);
    }
    enter(profile.role);
  }

  function showLogin() {
    live.ready = false;
    live.profile = null;
    currentRole = null;
    loginScreen.hidden = false;
    ownerShell.hidden = true;
    staffShell.hidden = true;
    busy(false);
    emailInput.focus();
  }

  function enter(role) {
    currentRole = role;
    loginScreen.hidden = true;
    if (role === 'staff') {
      ownerShell.hidden = true;
      staffShell.hidden = false;
      refreshStaff();
      window.scrollTo(0, 0);
      return;
    }
    ownerShell.hidden = false;
    staffShell.hidden = true;
    const firstName = (live.profile.full_name || (live.profile.email || '').split('@')[0] || 'Owner').trim().split(' ')[0];
    ownerShell.querySelector('.intro h1').innerHTML = `Good day, <em>${esc(firstName)}.</em>`;
    ownerShell.querySelector('.avatar').textContent = initials(live.profile.full_name || live.profile.email);
    refreshOwner('Overview', false);
    window.scrollTo(0, 0);
  }

  /* Live data badge */
  function markLive(root) {
    if (!root) return;
    root.querySelectorAll('.updated').forEach(el => { el.innerHTML = '<span class="dot"></span> Live gym data · Synced ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }); });
    root.querySelectorAll('.report-demo').forEach(el => { el.innerHTML = '<span class="dot"></span> LIVE DATA'; });
  }

  /* Keep the sliding tab highlight aligned with live content */
  function revealNavigation(nav) {
    const active = nav.querySelector('button.active');
    if (!active) return;
    const apply = () => {
      const navBox = nav.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      nav.style.setProperty('--tab-left', box.left - navBox.left + nav.scrollLeft + 'px');
      nav.style.setProperty('--tab-width', box.width + 'px');
    };
    apply();
    requestAnimationFrame(apply);
    setTimeout(apply, 420);
  }

  async function refreshData(quiet) {
    try {
      await ui.loadAll();
      if (!quiet) toastLive('Dashboard refreshed with the latest gym records.');
    } catch (error) {
      toastLive(friendly(error));
    }
  }

  function toastLive(message) {
    document.querySelectorAll('.app-toast').forEach(t => t.remove());
    const item = document.createElement('div');
    item.className = 'app-toast';
    item.setAttribute('role', 'status');
    item.textContent = message;
    document.body.append(item);
    setTimeout(() => item.remove(), 3500);
  }

  /* Owner views ----------------------------------------------------------- */
  const ownerNav = ownerShell.querySelector('.nav');
  const periodWrap = document.querySelector('#period-wrap');
  const periodButton = document.querySelector('#period');
  const periodMenu = document.querySelector('#period-menu');

  function selectTab(nav, button) {
    nav.querySelectorAll('button').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    revealNavigation(nav);
  }

  function syncPeriodControl(view) {
    if (periodWrap) periodWrap.style.display = ['Overview', 'Reports'].includes(view) ? '' : 'none';
    if (periodMenu) periodMenu.hidden = true;
    if (periodButton) {
      periodButton.textContent = live.period === 'week' ? 'This week ⌄' : 'This month ⌄';
      periodButton.setAttribute('aria-expanded', 'false');
    }
  }

  function fadeContent(root) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    try { root.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)' }); } catch (error) { /* animation optional */ }
  }

  /* Capture the navigation clicks so the live renderer always wins over the sample renderer. */
  document.addEventListener('click', event => {
    const ownerButton = event.target.closest('.shell:not(#staff-shell) .nav button');
    const staffButton = event.target.closest('#staff-shell .nav button');
    if (!ownerButton && !staffButton) return;
    if (currentRole !== 'owner' && currentRole !== 'staff') return;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (ownerButton) {
      if (ownerButton.classList.contains('active')) return;
      selectTab(ownerNav, ownerButton);
      const view = ownerButton.textContent.trim();
      syncPeriodControl(view);
      refreshOwner(view, false);
      fadeContent(ownerContent);
    } else {
      if (staffButton.classList.contains('active')) return;
      selectTab(staffNav, staffButton);
      refreshStaff(staffButton.dataset.staffTab);
      fadeContent(staffContent);
    }
  }, true);

  /* Period selector drives live reports and overview. */
  document.addEventListener('click', event => {
    if (currentRole !== 'owner') return;
    const item = event.target.closest('#period-menu button[data-period]');
    if (item) {
      event.stopImmediatePropagation();
      event.preventDefault();
      live.period = item.dataset.period;
      syncPeriodControl(ownerNav.querySelector('button.active')?.textContent.trim() || 'Overview');
      const view = ownerNav.querySelector('button.active')?.textContent.trim() || 'Overview';
      refreshData(true).then(() => { refreshOwner(view, false); fadeContent(ownerContent); });
      return;
    }
    if (event.target.closest('#period')) {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!periodMenu) return;
      periodMenu.hidden = !periodMenu.hidden;
      periodButton?.setAttribute('aria-expanded', String(!periodMenu.hidden));
    }
  }, true);

  function refreshOwner(tab, animate = true) {
    paintGreeting();
    markLive(ownerContent);
    if (tab === 'Overview') renderOwnerOverview();
    else if (tab === 'Members') renderOwnerMembers();
    else if (tab === 'Staff') renderOwnerTeam();
    else if (tab === 'Reports') renderOwnerReports();
    else if (tab === 'Settings') renderOwnerSettings();
    else if (tab === 'Inventory') renderOwnerInventory();
    else if (tab === 'Finance') renderOwnerFinance();
    else if (tab === 'Cash') renderOwnerCash();
    else if (tab === 'Activity') renderOwnerActivity();
    else if (tab === 'Announce') renderOwnerBroadcast();
    markLive(ownerContent);
    revealNavigation(ownerNav);
    if (animate && typeof window.revealDashboard === 'function') window.revealDashboard(ownerContent);
  }

  function summary() {
    const s = live.summary || {};
    const active = live.members.filter(m => m.effective_status === 'Active').length;
    const expiring = live.members.filter(m => m.expiring_soon).length;
    const expiringList = live.members.filter(m => m.expiring_soon).slice(0, 4);
    return { ...s, active, expiring, expiringList };
  }

  function paintGreeting() {
    const el = document.getElementById('owner-greeting-name');
    if (!el) return;
    const name = (live.profile?.full_name || '').trim();
    const first = name ? name.split(/\s+/)[0] : '';
    el.textContent = first ? `${first}.` : 'there.';
  }

  function renderOwnerOverview() {
    const s = summary();
    const range = live.period === 'week' ? 'this week' : 'this month';
    const revenue = Number(s.membership_revenue || 0) + Number(s.walkin_revenue || 0) + Number(s.product_revenue || 0);
    const recent = live.payments.slice(0, 5);
    const updates = live.activity.slice(0, 6);
    const pending = live.payments.filter(p => p.status === 'pending');
    const lowStock = live.inventory.filter(i => i.is_active && i.quantity <= i.threshold);
    const todayVisits = live.visits.filter(v => v.visit_date === phToday());
    const pct = s.active ? Math.min(100, (Number(s.checkins_today || 0) / Number(s.active)) * 100) : 0;

    ownerContent.innerHTML = `
      <div class="section-head"><div><div class="eyebrow" style="color:#9baa96">THE DAILY PULSE</div><h2>Your gym overview</h2><p>Live numbers from across your gym · ${range}.</p></div><div class="updated"><span class="dot"></span> Live gym data</div></div>
      <div class="grid">
        <article class="card"><div class="card-title"><span class="label"><span class="badge-icon">♙</span> Active members</span><span class="more">···</span></div><div class="metric-row"><span class="metric">${s.active}</span><span class="change">${s.expiring ? s.expiring + ' expiring' : 'All current'}</span></div><div class="sub">${s.total_members || 0} total members <b>· ${s.deactivated_members || 0} deactivated</b></div><div class="capacity"><div class="cap-head"><span>Active memberships</span><b>${s.expired || 0} expired</b></div><div class="progress"><span style="width:${s.total_members ? Math.round((s.active / s.total_members) * 100) : 0}%"></span></div><div class="cap-note"><span>${s.active} active</span><span>${s.total_members || 0} total</span></div></div><div class="card-footer"><span>EXPIRING SOON<strong>${s.expiring || 0}</strong></span><span>EXPIRED<strong>${s.expired || 0}</strong></span></div></article>
        <article class="card"><div class="card-title"><span class="label"><span class="badge-icon">↗</span> Revenue</span><span class="more">···</span></div><div class="metric-row"><span class="metric">${peso(revenue)}</span><span class="change">${range}</span></div><div class="sub">Confirmed payments <b>· ${pending.length} awaiting verification</b></div><div class="capacity"><div class="cap-head"><span>Revenue mix</span><b>${peso(revenue)}</b></div><div class="progress"><span style="width:${revenue ? Math.max(6, (Number(s.membership_revenue || 0) / revenue) * 100) : 0}%"></span></div><div class="cap-note"><span>Memberships ${peso(s.membership_revenue)}</span><span>Walk-ins ${peso(s.walkin_revenue)}</span></div></div><div class="card-footer"><span>WALK-INS<strong>${peso(s.walkin_revenue)}</strong></span><span>PRODUCTS<strong>${peso(s.product_revenue)}</strong></span></div></article>
        <article class="card"><div class="card-title"><span class="label"><span class="badge-icon">◷</span> Check-ins today</span><span class="more">···</span></div><div class="metric-row"><span class="metric">${s.checkins_today || 0}</span><span class="change">${s.open_visits || 0} still inside</span></div><div class="sub">members checked in <b>today</b></div><div class="capacity"><div class="cap-head"><span>Today’s check-ins</span><b>${pct.toFixed(1)}% of active members</b></div><div class="progress"><span style="width:${pct}%"></span></div><div class="cap-note"><span>${s.checkins_today || 0} checked in today</span><span>${s.active} active members</span></div></div><div class="card-footer"><span>OPEN VISITS<strong>${s.open_visits || 0}</strong></span><span>UNIQUE TODAY<strong>${new Set(todayVisits.map(v => v.member_id)).size}</strong></span></div></article>
      </div>
      <div class="lower"><section class="card"><div class="panel-head"><div><h3>What’s happening</h3><p>Live activity from your team and members.</p></div></div>
        <div class="owner-updates"><div class="owner-update-stats">
          <div><span>CHECK-INS</span><strong>${s.checkins_today || 0}</strong><small>Today</small></div>
          <div><span>MEMBERS</span><strong>${s.active}</strong><small>Active</small></div>
          <div><span>PENDING PAYMENTS</span><strong>${pending.length}</strong><small>Needs review</small></div>
          <div><span>LOW STOCK</span><strong>${lowStock.length}</strong><small>Products</small></div>
        </div><div class="owner-update-grid">
          <div class="owner-update-panel"><div class="owner-panel-head"><div><strong>Needs your review</strong><p>Online payments and profile requests.</p></div></div>
            ${pending.length || live.requests.filter(r => r.status === 'pending').length ? [...pending.map(p => `<div class="activity"><div class="activity-icon">₱</div><div class="activity-text"><b>${esc(p.member_name || 'Member')} · ${peso(p.amount)}</b><br>${esc(p.method)} payment needs verification · ${esc(p.receipt_no)}</div><button class="outline pay-approve" data-id="${p.id}">Verify</button></div>`), ...live.requests.filter(r => r.status === 'pending').map(r => { const m = live.members.find(x => x.id === r.member_id); return `<div class="activity"><div class="activity-icon">✎</div><div class="activity-text"><b>${esc(m?.full_name || 'Member')}</b><br>Profile change request</div><button class="outline request-approve" data-id="${r.id}">Review</button></div>`; })].join('') : '<p class="sub" style="padding:8px 0">Nothing waiting for approval.</p>'}
          </div>
          <div class="owner-update-panel"><div class="owner-panel-head"><div><strong>Latest activity</strong><p>Recorded by your team.</p></div></div>
            ${updates.length ? updates.slice(0, 5).map(a => `<div class="activity"><div class="activity-icon">✳</div><div class="activity-text"><b>${esc(a.summary)}</b><br>${esc(a.actor_name || 'Gym')}</div><div class="activity-time">${esc(phDateTime(a.created_at))}</div></div>`).join('') : '<p class="sub" style="padding:8px 0">No activity yet.</p>'}
          </div>
        </div></div>
        <div class="activity-list">${recent.length ? recent.slice(0, 4).map(p => `<div class="activity"><div class="activity-icon">₱</div><div class="activity-text"><b>${esc(p.member_name || 'Member')} · ${peso(p.amount)}</b><br>${esc(p.method)} · ${esc(p.receipt_no)} · ${esc(p.status)}</div><div class="activity-time">${esc(phDateTime(p.created_at))}</div></div>`).join('') : '<p class="sub" style="padding:10px 0">No payments recorded yet.</p>'}</div>
      </section></div>`;

    ownerContent.querySelectorAll('.pay-approve').forEach(button => button.onclick = () => reviewPayment(button.dataset.id));
    ownerContent.querySelectorAll('.request-approve').forEach(button => button.onclick = () => reviewRequest(button.dataset.id));
  }

  async function reviewPayment(id) {
    const payment = live.payments.find(p => p.id === id);
    if (!payment) return;
    let proofNote = '';
    if (payment.proof_path) {
      const { data } = await sb.storage.from('payment-proofs').createSignedUrl(payment.proof_path, 600);
      proofNote = data?.signedUrl ? `<a href="${data.signedUrl}" target="_blank" rel="noopener" style="color:#3f6b45;font-weight:700">Open payment screenshot ↗</a>` : 'Screenshot available.';
    }
    const choice = await confirmDialog({
      title: 'Verify this payment?',
      body: `${payment.member_name || 'Member'} paid <b>${peso(payment.amount)}</b> by ${esc(payment.method)}${payment.reference ? ' · Ref ' + esc(payment.reference) : ''}.<br>${proofNote || 'No screenshot attached.'}<br><br>Confirm only after you have checked the gym’s account.`,
      confirm: 'Verify payment',
      cancel: 'Not yet'
    });
    if (!choice) return;
    try {
      await ui.call('approve_payment', { p_payment_id: id });
      toastLive('Payment verified and membership extended.');
      await refreshData(true);
      renderOwnerOverview();
    } catch (error) { toastLive(friendly(error)); }
  }

  async function reviewRequest(id) {
    const request = live.requests.find(r => r.id === id);
    const member = live.members.find(m => m.id === request?.member_id);
    const changes = request ? Object.entries(request.changes).map(([k, v]) => `${k.replace(/_/g, ' ')}: <b>${esc(v)}</b>`).join('<br>') : '';
    const approve = await confirmDialog({ title: 'Profile change request', body: `${esc(member?.full_name || 'Member')} requested:<br>${changes}<br><br>Approve to update their member record.`, confirm: 'Approve', cancel: 'Reject' });
    try {
      await ui.call('review_profile_change', { p_request_id: id, p_approve: !!approve, p_note: approve ? null : 'Declined by owner' });
      toastLive(approve ? 'Profile change approved.' : 'Profile change rejected.');
      await refreshData(true);
      renderOwnerOverview();
    } catch (error) { toastLive(friendly(error)); }
  }

  function renderOwnerMembers() {
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">YOUR COMMUNITY</div><h2>Member directory</h2><p>Live member records from the shared gym database.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="owner-member-stats">
        <div class="card"><span>ALL MEMBERS</span><strong>${live.members.length}</strong><small>Including deactivated</small></div>
        <div class="card"><span>ACTIVE</span><strong>${live.members.filter(m => m.effective_status === 'Active').length}</strong><small>Can check in</small></div>
        <div class="card"><span>EXPIRING SOON</span><strong>${live.members.filter(m => m.expiring_soon).length}</strong><small>Within 7 days</small></div>
        <div class="card"><span>DEACTIVATED</span><strong>${live.members.filter(m => m.effective_status === 'Deactivated').length}</strong><small>Expired or turned off</small></div>
      </div>
      <div class="owner-members-layout"><section class="card owner-directory"><div class="panel-head"><div><div class="staff-kicker">MEMBERS AT A GLANCE</div><h3>All members</h3><p>Newest members first. Select a member for full details.</p></div><button class="outline" id="owner-export">Export CSV ↓</button></div>
        <div class="owner-member-controls"><input class="login-input" id="owner-search" placeholder="Search name, ID, phone or email"><select class="login-input" id="owner-filter"><option value="all">All members</option><option value="active">Active</option><option value="deactivated">Deactivated</option><option value="expiring">Expiring soon</option></select></div>
        <div class="owner-member-list" id="owner-member-list">${memberRows()}</div>
        <p id="owner-empty" class="sub" hidden>No members match your search.</p></section>
      <aside class="card owner-member-detail"><div id="owner-detail"><div class="staff-kicker">MEMBER PROFILE</div><div class="owner-profile-placeholder"><div class="owner-profile-symbol">♙</div><h3>Select a member</h3><p>Review their membership, contact details, payments and visits.</p></div></div></aside></div>`;
    const search = ownerContent.querySelector('#owner-search');
    const filter = ownerContent.querySelector('#owner-filter');
    const applyFilter = () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      ownerContent.querySelectorAll('.owner-member-row').forEach(row => {
        const member = live.members.find(m => m.id === row.dataset.id);
        if (!member) return;
        const text = [member.full_name, member.member_no, member.phone, member.email].join(' ').toLowerCase();
        const mode = filter.value;
        const match = text.includes(q) && (mode === 'all' || (mode === 'active' && member.effective_status === 'Active') || (mode === 'deactivated' && member.effective_status === 'Deactivated') || (mode === 'expiring' && member.expiring_soon));
        row.style.display = match ? '' : 'none';
        if (match) shown++;
      });
      ownerContent.querySelector('#owner-empty').hidden = !!shown;
    };
    search.oninput = applyFilter;
    filter.onchange = applyFilter;
    ownerContent.querySelectorAll('.owner-profile').forEach(button => button.onclick = () => showOwnerMember(button.dataset.id));
    ownerContent.querySelector('#owner-export').onclick = exportMembers;
  }

  function memberRows() {
    if (!live.members.length) return '<p class="sub" style="padding:16px 0">No members yet. Staff can add the first member from the staff portal.</p>';
    return live.members.map(m => {
      const tag = m.effective_status === 'Deactivated' ? 'status-deactivated' : m.expiring_soon ? 'status-expiring' : '';
      return `<div class="owner-member-row" data-id="${m.id}"><span class="owner-member-avatar">${esc(initials(m.full_name))}</span><div class="owner-member-info"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'Plan not set')}</small></div><div class="owner-member-expiry"><small>EXPIRES</small><strong>${esc(fmtDay(m.expires_on))}</strong></div><span class="status-tag ${tag}">${m.effective_status === 'Deactivated' && m.expired ? 'Expired' : m.effective_status}${m.expiring_soon ? ' · Soon' : ''}</span><button class="outline owner-profile" data-id="${m.id}">View ↗</button></div>`;
    }).join('');
  }

  function showOwnerMember(id) {
    const member = live.members.find(m => m.id === id);
    if (!member) return;
    const payments = live.payments.filter(p => p.member_id === id).slice(0, 6);
    const visits = live.visits.filter(v => v.member_id === id).slice(0, 6);
    const detail = ownerContent.querySelector('#owner-detail');
    detail.innerHTML = `<div class="staff-kicker">MEMBER PROFILE</div>
      <div class="profile-heading"><span class="owner-profile-symbol">${esc(initials(member.full_name))}</span><div><h3>${esc(member.full_name)}</h3><p>${esc(member.member_no)} · joined ${esc(fmtDay(member.joined_on))}</p></div><span class="status-tag ${member.effective_status === 'Deactivated' ? 'status-deactivated' : member.expiring_soon ? 'status-expiring' : ''}">${member.effective_status}</span></div>
      <div class="profile-section"><div class="profile-section-title">MEMBERSHIP <span>${esc(member.plan_months ? planLabel(member.plan_months) : 'No plan')}</span></div>
        <div class="profile-line"><span>Start</span><strong>${esc(fmtDay(member.starts_on))}</strong></div>
        <div class="profile-line"><span>Expiry</span><strong>${esc(fmtDay(member.expires_on))}</strong></div>
        <div class="profile-line"><span>Reminders</span><strong>${member.reminders ? 'On' : 'Off'}</strong></div></div>
      <div class="profile-section"><div class="profile-section-title">CONTACT</div>
        <div class="profile-line"><span>Mobile</span><strong>${esc(dash(member.phone))}</strong></div>
        <div class="profile-line"><span>Email</span><strong>${esc(dash(member.email))}</strong></div>
        <div class="profile-line"><span>Emergency</span><strong>${esc(dash(member.emergency_contact))}</strong></div></div>
      <div class="profile-section"><div class="profile-section-title">RECENT PAYMENTS</div>${payments.length ? payments.map(p => `<div class="profile-history"><div>${esc(p.receipt_no)}<small>${esc(phDateTime(p.created_at))} · ${esc(p.method)} · ${esc(p.status)}</small></div><b>${peso(p.amount)}</b></div>`).join('') : '<p class="sub">No payments recorded.</p>'}</div>
      <div class="profile-section"><div class="profile-section-title">RECENT VISITS</div>${visits.length ? visits.map(v => `<div class="profile-history"><div>${esc(phDateTime(v.checked_in_at))}<small>${v.checked_out_at ? 'Out ' + esc(phDateTime(v.checked_out_at)) : 'Still inside'}</small></div></div>`).join('') : '<p class="sub">No visits recorded.</p>'}</div>
      ${memberActionsSection(member)}
      <div class="profile-section"><div class="profile-section-title">MEMBER PORTAL</div><p class="sub" style="line-height:1.8">${member.auth_user_id ? 'This member has a linked portal account.' : 'No portal account linked yet. Create the account in Supabase Auth, then link it here so they can sign in to the member portal.'}</p>${member.auth_user_id ? '' : `<label class="field">Account email</label><input class="login-input" id="link-email" type="email" placeholder="member@email.com"><button class="outline" id="link-account" style="margin-top:10px">Link portal account</button>`}</div>`;
    wireMemberActions(member, () => { const still = live.members.find(m => m.id === member.id); if (still) showOwnerMember(still.id); else renderOwnerMembers(); });
    const linkButton = detail.querySelector('#link-account');
    if (linkButton) linkButton.onclick = async () => {
      const email = detail.querySelector('#link-email').value.trim();
      if (!email) return toastLive('Enter the account email.');
      try {
        await ui.call('link_member_account', { p_member_id: member.id, p_email: email });
        toastLive('Portal account linked.');
        await refreshData(true);
        showOwnerMember(memberId);
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  /* ---- Member lifecycle: photo, freeze, archive, merge ------------------ */
  function memberActionsSection(member) {
    const frozen = !!member.frozen_at;
    const archived = !!member.archived_at;
    return `<div class="profile-section member-actions-section">
      <div class="profile-section-title">MANAGE MEMBER</div>
      <div class="profile-photo-row">
        <div class="member-photo" id="member-photo">${member.photo_url ? `<img src="${esc(member.photo_url)}" alt="">` : `<span>${esc(initials(member.full_name))}</span>`}</div>
        <div class="photo-controls">
          <label class="outline photo-upload">${member.photo_url ? 'Change photo' : 'Upload photo'}<input type="file" id="photo-file" accept="image/jpeg,image/png,image/webp" hidden></label>
          ${member.photo_url ? '<button class="outline" id="photo-remove">Remove</button>' : ''}
          <small>JPG, PNG or WebP up to 2 MB.</small>
        </div>
      </div>
      ${frozen ? `<div class="frozen-banner">Frozen until <b>${esc(fmtDay(member.frozen_until))}</b> — expiry moved to ${esc(fmtDay(member.expires_on))}.<br><small>${esc(member.freeze_reason || '')}</small></div>
        <button class="outline member-act" id="act-unfreeze">Resume membership</button>`
      : archived ? `<div class="frozen-banner">Archived — ${esc(member.archive_reason || 'no reason recorded')}.<br><small>Their payments and visits are kept in the books.</small></div>
        <button class="outline member-act" id="act-restore">Restore member</button>`
      : `<div class="member-act-grid">
          <button class="outline member-act" id="act-freeze">Freeze / hold</button>
          <button class="outline member-act" id="act-merge">Merge duplicate</button>
          <button class="outline member-act member-act-danger" id="act-archive">Archive</button>
        </div>`}
    </div>`;
  }

  function wireMemberActions(member, rerender) {
    const detail = ownerContent.querySelector('#owner-detail');
    if (!detail) return;
    const file = detail.querySelector('#photo-file');
    if (file) file.onchange = async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      try { await validateImage(chosen); }
      catch (invalidFile) { return toastLive(invalidFile.message); }
      const label = detail.querySelector('.photo-upload');
      if (label) label.textContent = 'Uploading…';
      try {
        const ext = chosen.type === 'image/png' ? 'png' : chosen.type === 'image/webp' ? 'webp' : 'jpg';
        const path = `${member.id}/${Date.now()}.${ext}`;
        const upload = await sb.storage.from('member-photos').upload(path, chosen, { upsert: true, contentType: chosen.type });
        if (upload.error) throw upload.error;
        const { data: pub } = sb.storage.from('member-photos').getPublicUrl(path);
        const res = await sb.from('members').update({ photo_url: pub.publicUrl }).eq('id', member.id);
        if (res.error) throw res.error;
        toastLive('Photo updated.');
        await refreshData(true);
        rerender();
      } catch (error) {
        if (label) label.textContent = member.photo_url ? 'Change photo' : 'Upload photo';
        toastLive(friendly(error));
      }
    };
    const remove = detail.querySelector('#photo-remove');
    if (remove) remove.onclick = async () => {
      try {
        await sb.from('members').update({ photo_url: null }).eq('id', member.id);
        toastLive('Photo removed.'); await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    const freeze = detail.querySelector('#act-freeze');
    if (freeze) freeze.onclick = () => freezeDialog(member, rerender);
    const unfreeze = detail.querySelector('#act-unfreeze');
    if (unfreeze) unfreeze.onclick = async () => {
      const reason = await askReason('Resume membership', 'Why is this member coming back early?');
      if (!reason) return;
      try {
        const row = await call('unfreeze_member', { p_member_id: member.id, p_reason: reason });
        toastLive(`Membership resumed — expires ${fmtDay(row.expires_on)}`);
        await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    const archive = detail.querySelector('#act-archive');
    if (archive) archive.onclick = async () => {
      const reason = await askReason('Archive member', 'Why is this member being archived? Their payment history is kept either way.');
      if (!reason) return;
      try {
        await call('archive_member', { p_member_id: member.id, p_reason: reason });
        toastLive('Member archived — history kept.');
        await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    const restore = detail.querySelector('#act-restore');
    if (restore) restore.onclick = async () => {
      try {
        await call('restore_member', { p_member_id: member.id });
        toastLive('Member restored.');
        await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    const merge = detail.querySelector('#act-merge');
    if (merge) merge.onclick = () => mergeDialog(member, rerender);
  }

  function freezeDialog(member, rerender) {
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    const twoWeeks = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">MEMBERSHIP HOLD</div><h2>Freeze ${esc(member.full_name.split(' ')[0])}'s membership</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <div class="renew-expiry"><span>Current expiry</span><strong>${esc(fmtDay(member.expires_on))}</strong></div>
      <label class="field" for="freeze-until">Hold until</label><input class="login-input" id="freeze-until" type="date" value="${esc(twoWeeks)}" min="${esc(phToday())}">
      <label class="field" for="freeze-reason">Reason</label><input class="login-input" id="freeze-reason" maxlength="160" placeholder="e.g. travelling, injury">
      <p class="renew-hint">The expiry date moves out by the number of days held, so they never pay for time they can't use.</p>
      <div class="renew-actions"><button type="button" class="outline" id="freeze-cancel">Cancel</button><button type="button" class="login-submit" id="freeze-go">Freeze membership</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#freeze-cancel').onclick = close;
    box.querySelector('#freeze-go').onclick = async () => {
      const until = box.querySelector('#freeze-until').value;
      const reason = box.querySelector('#freeze-reason').value.trim();
      if (!until) return toastLive('Choose the date the hold ends.');
      if (reason.length < 3) return toastLive('Give a short reason for the freeze.');
      try {
        const row = await call('freeze_member', { p_member_id: member.id, p_until: until, p_reason: reason });
        close();
        toastLive(`Frozen until ${fmtDay(until)} — expiry moved to ${fmtDay(row.expires_on)}`);
        await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
  }

  function mergeDialog(member, rerender) {
    const others = live.members.filter(m => m.id !== member.id && !m.archived_at && !m.merged_into);
    if (!others.length) return toastLive('There is no other member to merge with.');
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">DUPLICATE RECORD</div><h2>Merge into ${esc(member.full_name)}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <p class="sub">Pick the duplicate record. Its payments, visits and passes move to <b>${esc(member.member_no)}</b>, and it is retired — nothing is deleted.</p>
      <label class="field" for="merge-target">Duplicate to merge in</label>
      <select class="login-input" id="merge-target">${others.map(m => `<option value="${m.id}">${esc(m.full_name)} · ${esc(m.member_no)} · expires ${esc(fmtDay(m.expires_on))}</option>`).join('')}</select>
      <label class="field" for="merge-reason">Reason</label><input class="login-input" id="merge-reason" maxlength="160" placeholder="e.g. same person registered twice">
      <p class="renew-hint">The surviving record keeps the later expiry date. Revenue totals do not change.</p>
      <div class="renew-actions"><button type="button" class="outline" id="merge-cancel">Cancel</button><button type="button" class="login-submit" id="merge-go">Merge records</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#merge-cancel').onclick = close;
    box.querySelector('#merge-go').onclick = async () => {
      const target = box.querySelector('#merge-target').value;
      const reason = box.querySelector('#merge-reason').value.trim();
      if (reason.length < 3) return toastLive('Give a short reason for the merge.');
      try {
        const result = await call('merge_members', { p_keep_id: member.id, p_merge_id: target, p_reason: reason });
        close();
        toastLive(`Merged ${result.merged} into ${result.keep} — ${result.payments_moved} payments moved.`);
        await refreshData(true); rerender();
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
  }

  function exportMembers() {
    const header = ['Member ID', 'Name', 'Phone', 'Email', 'Plan', 'Start', 'Expiry', 'Status', 'Joined'];
    const rows = live.members.map(m => [m.member_no, m.full_name, m.phone || '', m.email || '', m.plan_months ? planLabel(m.plan_months) : '', m.starts_on || '', m.expires_on || '', m.effective_status, m.joined_on]);
    downloadCsv('gimmda-members.csv', [header, ...rows]);
  }

  function downloadCsv(name, rows) {
    const csv = rows.map(r => r.map(cell => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* Per-action permissions: what this person may actually do. */
  const PERMISSION_LABELS = [
    ['can_record_payment', 'Take membership payments', 'Renewals and new memberships'],
    ['can_sell_products', 'Sell products', 'Use the POS and take stock out'],
    ['can_record_walkin', 'Record walk-ins', 'Charge and log day visitors'],
    ['can_check_in', 'Check members in', 'Open and close visits'],
    ['can_create_member', 'Add new members', 'Create member records'],
    ['can_view_reports', 'See reports', 'Revenue and attendance figures'],
    ['can_void', 'Void transactions', 'Reverse a recorded payment — off by default']
  ];

  async function permissionsDialog(staffId) {
    const person = live.team.find(t => t.id === staffId);
    const { data: existing } = await sb.from('staff_permissions').select('*').eq('staff_id', staffId).maybeSingle();
    const current = existing || {};
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">WHAT THEY CAN DO</div><h2>${esc(person?.full_name || 'Staff member')}</h2><p>${esc(person?.email || '')}</p></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <div class="perm-list">${PERMISSION_LABELS.map(([key, label, help]) => {
        // Everything is on by default except voiding, which stays owner-only until granted.
        const on = key === 'can_void' ? current.can_void === true : current[key] !== false;
        return `<label class="perm-row"><span><b>${label}</b><small>${help}</small></span><input type="checkbox" data-perm="${key}" ${on ? 'checked' : ''}></label>`;
      }).join('')}</div>
      <p class="renew-hint">Checked actions are enforced by the database, not just hidden in the screen — turning one off blocks it even if someone crafts the request themselves.</p>
      <div class="renew-actions"><button type="button" class="outline" id="perm-cancel">Cancel</button><button type="button" class="login-submit" id="perm-go">Save permissions</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#perm-cancel').onclick = close;
    box.querySelector('#perm-go').onclick = async () => {
      const row = { staff_id: staffId };
      box.querySelectorAll('input[data-perm]').forEach(input => { row[input.dataset.perm] = input.checked; });
      try {
        const { error } = await sb.from('staff_permissions').upsert(row);
        if (error) throw error;
        close();
        toastLive('Permissions saved.');
        await refreshData(true);
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
  }

  function renderOwnerTeam() {
    const staff = live.team.filter(t => t.role !== 'member');
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">THE PEOPLE BEHIND HILL</div><h2>Your team</h2><p>Accounts that can sign in to the gym dashboard.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="owner-member-stats"><div class="card"><span>TEAM ACCOUNTS</span><strong>${staff.length}</strong><small>Owners and staff</small></div><div class="card"><span>ACTIVE</span><strong>${staff.filter(t => t.is_active).length}</strong><small>Can sign in</small></div><div class="card"><span>DEACTIVATED</span><strong>${staff.filter(t => !t.is_active).length}</strong><small>Access blocked</small></div><div class="card"><span>TODAY’S ACTIVITY</span><strong>${live.activity.filter(a => phDateTime(a.created_at).includes(new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric' }))).length}</strong><small>Logged actions</small></div></div>
      <div class="owner-members-layout"><section class="card owner-directory"><div class="panel-head"><div><div class="staff-kicker">ACCESS CONTROL</div><h3>Team accounts</h3><p>Owner and staff accounts come from Supabase Auth.</p></div></div>
        <div id="team-list">${staff.map(t => `<div class="team-account"><div class="team-person"><span class="team-avatar">${esc(initials(t.full_name || t.email))}</span><div><strong>${esc(t.full_name || 'Unnamed account')}</strong><small>${esc(t.email || '')}</small></div></div><select class="login-input team-role" data-id="${t.id}" aria-label="Role for ${esc(t.email || 'account')}" ${t.id === live.profile.id ? 'disabled' : ''}><option value="owner" ${t.role === 'owner' ? 'selected' : ''}>Owner</option><option value="staff" ${t.role === 'staff' ? 'selected' : ''}>Staff</option><option value="member" ${t.role === 'member' ? 'selected' : ''}>Member</option></select><span class="status-tag ${t.is_active ? '' : 'status-deactivated'}">${t.is_active ? 'Active' : 'Deactivated'}</span>${t.id === live.profile.id || t.role === 'owner' ? '<span></span>' : `<div class="team-actions"><button class="outline team-perms" data-id="${t.id}">Permissions</button><button class="outline team-reset" data-id="${t.id}">Reset password</button><button class="outline team-toggle" data-id="${t.id}" data-active="${t.is_active}">${t.is_active ? 'Deactivate' : 'Activate'}</button></div>`}</div>`).join('') || '<p class="sub">No accounts yet.</p>'}</div>
        <div class="settings-notice" style="margin-top:14px">✳ &nbsp; Accounts are created in Supabase (Authentication → Users). Set the role here; staff see the staff portal and members use the member portal.</div></section>
      <aside class="card owner-member-detail"><div id="lockouts"></div><div class="staff-kicker" style="margin-top:16px">TEAM ACTIVITY</div>${live.activity.slice(0, 12).map(a => `<div class="profile-history"><div>${esc(a.summary)}<small>${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</small></div></div>`).join('') || '<p class="sub">No activity yet.</p>'}</aside></div>`;
    (async () => {
      const box = ownerContent.querySelector('#lockouts');
      if (!box) return;
      try {
        const rows = await call('locked_out_accounts');
        box.innerHTML = rows.length
          ? `<div class="staff-kicker" style="color:#a3594f">LOCKED OUT RIGHT NOW</div>${rows.map(r => `<div class="lockout-row"><div><strong>${esc(r.email)}</strong><small>${r.failures} failed attempts</small></div><button class="outline unlock-one" data-email="${esc(r.email)}">Unlock</button></div>`).join('')}`
          : `<div class="staff-kicker">SIGN-IN PROTECTION</div><p class="sub">Nobody is locked out. Five failed attempts in 15 minutes blocks an address until it's cleared.</p>`;
        box.querySelectorAll('.unlock-one').forEach(btn => btn.onclick = async () => {
          try {
            const r = await call('clear_login_failures', { p_email: btn.dataset.email });
            toastLive(`Unlocked — cleared ${r.cleared} failed attempts.`);
            renderOwnerTeam();
          } catch (error) { toastLive(friendly(error)); }
        });
      } catch (error) { box.innerHTML = ''; }
    })();
    ownerContent.querySelectorAll('.team-perms').forEach(button => button.onclick = () => permissionsDialog(button.dataset.id));
    ownerContent.querySelectorAll('.team-reset').forEach(button => button.onclick = () => {
      const account = live.team.find(t => t.id === button.dataset.id);
      if (account) resetTeamPassword(account);
    });
    ownerContent.querySelectorAll('.team-toggle').forEach(button => button.onclick = async () => {
      try {
        await ui.call('set_team_active', { p_user: button.dataset.id, p_active: button.dataset.active !== 'true' });
        await refreshData(true);
        renderOwnerTeam();
      } catch (error) { toastLive(friendly(error)); }
    });
    ownerContent.querySelectorAll('.team-role').forEach(select => select.onchange = async () => {
      try {
        await ui.call('set_team_role', { p_user: select.dataset.id, p_role: select.value });
        toastLive('Role updated.');
        await refreshData(true);
        renderOwnerTeam();
      } catch (error) { toastLive(friendly(error)); renderOwnerTeam(); }
    });
  }

  // Void (reverse) a payment, walk-in or product sale. Nothing is deleted: the
  // receipt stays with status 'voided' and a reason, and leaves revenue totals.
  async function voidTransaction(kind, id, reference) {
    const labels = { payment: 'membership payment', walkin: 'walk-in', sale: 'product sale' };
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<form class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">REVERSE A TRANSACTION</div><h2>Void ${esc(labels[kind] || 'transaction')}</h2><p>${esc(reference || '')}</p></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <div class="settings-notice" style="margin:16px 0">⚠ &nbsp; The receipt is kept and marked voided. It will no longer count toward revenue.${kind === 'sale' ? ' Stock is returned to inventory.' : ''}${kind === 'payment' ? ' The membership dates are rolled back if this payment set them.' : ''}</div>
      <label class="field">Reason for voiding (required)</label><input class="login-input void-input" maxlength="120" placeholder="e.g. keyed ₱15,000 instead of ₱1,500" required>
      <div class="renew-actions"><button type="button" class="outline act-cancel">Cancel</button><button class="login-submit" type="submit">Void transaction</button></div>
      <p class="renew-hint">This is recorded in the activity log with your name.</p></form>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('.act-cancel').onclick = close;
    box.addEventListener('cancel', event => { event.preventDefault(); close(); });
    box.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const reason = box.querySelector('.void-input').value.trim();
      if (!reason) return;
      const fn = kind === 'sale' ? 'void_product_sale' : kind === 'walkin' ? 'void_walkin' : 'void_payment';
      const args = kind === 'sale' ? { p_sale_id: id, p_reason: reason }
        : kind === 'walkin' ? { p_walkin_id: id, p_reason: reason }
          : { p_payment_id: id, p_reason: reason };
      try {
        await ui.call(fn, args);
        close();
        toastLive('Transaction voided and removed from revenue.');
        await refreshData(true);
        renderOwnerReports();
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
    box.querySelector('.void-input').focus();
  }

  function renderOwnerReports() {
    const range = live.period === 'week' ? ui.weekRange() : ui.monthRange();
    const inRange = date => date && date.slice(0, 10) >= range.from && date.slice(0, 10) <= range.to;
    const live$ = row => !row.voided_at;
    const payments = live.payments.filter(p => p.status === 'approved' && live$(p) && inRange(p.paid_on));
    const membership = payments.filter(p => p.category === 'membership').reduce((n, p) => n + Number(p.amount), 0);
    const walkin = live.walkins.filter(w => live$(w) && inRange(w.visited_on)).reduce((n, w) => n + Number(w.amount), 0);
    const product = live.sales.filter(s => live$(s) && inRange(s.sold_on)).reduce((n, s) => n + Number(s.total), 0);
    const reversed = [
      ...live.payments.filter(p => p.voided_at && inRange(p.paid_on)).map(p => ({ ref: p.receipt_no, kind: 'Membership', amount: Number(p.amount), reason: p.void_reason })),
      ...live.walkins.filter(w => w.voided_at && inRange(w.visited_on)).map(w => ({ ref: w.receipt_no, kind: 'Walk-in', amount: Number(w.amount), reason: w.void_reason })),
      ...live.sales.filter(s => s.voided_at && inRange(s.sold_on)).map(s => ({ ref: s.receipt_no, kind: 'Product', amount: Number(s.total), reason: s.void_reason }))
    ];
    const reversedTotal = reversed.reduce((n, r) => n + r.amount, 0);
    const total = membership + walkin + product;
    const members = live.members;
    const transactions = [
      ...live.payments.filter(p => inRange(p.paid_on)).map(p => ({ id: p.id, kind: 'payment', name: p.member_name || 'Member', type: p.receipt_no, category: 'Membership', date: p.paid_on, method: p.method, amount: Number(p.amount), status: p.status, voided: !!p.voided_at, reason: p.void_reason })),
      ...live.walkins.filter(w => inRange(w.visited_on)).map(w => ({ id: w.id, kind: 'walkin', name: w.visitor_name, type: w.receipt_no, category: 'Walk-in', date: w.visited_on, method: w.method, amount: Number(w.amount), status: w.voided_at ? 'voided' : 'approved', voided: !!w.voided_at, reason: w.void_reason })),
      ...live.sales.filter(s => inRange(s.sold_on)).map(s => ({ id: s.id, kind: 'sale', name: s.customer_name || 'Walk-in customer', type: s.receipt_no, category: 'Product', date: s.sold_on, method: s.method, amount: Number(s.total), status: s.voided_at ? 'voided' : 'approved', voided: !!s.voided_at, reason: s.void_reason }))
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">THE BIGGER PICTURE</div><h2>Gym reports</h2><p>Built from live payments, visits and memberships.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="report-metrics" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:16px"><div class="report-card"><span>REVENUE</span><strong>${peso(total)}</strong><small>${live.period === 'week' ? 'This week' : 'This month'}</small></div><div class="report-card"><span>MEMBERSHIPS</span><strong>${peso(membership)}</strong><small>Verified payments</small></div><div class="report-card"><span>WALK-INS</span><strong>${peso(walkin)}</strong><small>Separate from memberships</small></div><div class="report-card"><span>PRODUCT SALES</span><strong>${peso(product)}</strong><small>${live.sales.filter(s => inRange(s.sold_on) && live$(s)).length} receipts</small></div>${reversed.length ? `<div class="report-card report-card-muted"><span>REVERSED</span><strong>−${peso(reversedTotal)}</strong><small>${reversed.length} voided · excluded from revenue</small></div>` : ''}</div>
      <section class="card page-panel"><div class="panel-head"><div><h3>Performance snapshot</h3><p>${live.period === 'week' ? 'This week' : 'This month'} compared with your live records.</p></div><button class="outline" id="report-export">Export transactions ↓</button></div>
        <div class="report-breakdown"><div><span>Active members</span><strong>${members.filter(m => m.effective_status === 'Active').length}</strong></div><div><span>New members (period)</span><strong>${members.filter(m => inRange(m.joined_on)).length}</strong></div><div><span>Check-ins (period)</span><strong>${live.visits.filter(v => inRange(v.visit_date)).length}</strong></div><div><span>Avg. daily check-ins</span><strong>${(live.visits.filter(v => inRange(v.visit_date)).length / (live.period === 'week' ? 7 : Math.max(1, Number(range.to.slice(8))))).toFixed(1)}</strong></div></div></section>
      <section class="card page-panel"><div class="panel-head"><div><h3>Transactions</h3><p>Every recorded payment in this period, newest first.</p></div></div>
        <div class="report-table-wrap"><table class="report-table"><thead><tr><th>PERSON / REFERENCE</th><th>TYPE</th><th>DATE</th><th>METHOD</th><th>STATUS</th><th>AMOUNT</th><th></th></tr></thead><tbody>${transactions.length ? transactions.map(t => `<tr class="${t.voided ? 'row-is-voided' : ''}"><td><strong>${esc(t.name)}</strong><small>${esc(t.type)}</small></td><td><span class="report-type ${t.category === 'Walk-in' ? 'walk' : ''}">${t.category}</span></td><td>${esc(fmtDay(t.date))}</td><td>${esc(t.method)}</td><td><span class="status-tag${t.voided ? ' status-deactivated' : ''}">${esc(t.status)}</span>${t.voided && t.reason ? `<small class="void-reason">${esc(t.reason)}</small>` : ''}</td><td class="report-amount${t.voided ? ' voided-amount' : ''}">${peso(t.amount)}</td><td>${!t.voided && t.status !== 'pending' ? `<button class="outline row-void" data-id="${t.id}" data-kind="${t.kind}" data-ref="${esc(t.type)}">Void</button>` : ''}</td></tr>`).join('') : '<tr><td colspan="7" class="report-empty">No transactions in this period.</td></tr>'}</tbody></table></div></section>`;
    ownerContent.querySelectorAll('.row-void').forEach(button => button.onclick = () => voidTransaction(button.dataset.kind, button.dataset.id, button.dataset.ref));
    ownerContent.querySelector('#report-export').onclick = () => downloadCsv('gimmda-transactions.csv', [['Name', 'Reference', 'Type', 'Date', 'Method', 'Status', 'Amount'], ...transactions.map(t => [t.name, t.type, t.category, t.date, t.method, t.status, t.amount])]);
  }


  function renderOwnerInventory() {
    const items = live.inventory;
    const low = items.filter(i => i.quantity <= i.threshold);
    const sold = live.sales.filter(s => s.sold_on === phToday()).reduce((n, s) => n + Number(s.total), 0);
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">GYM OPERATIONS</div><h2>Inventory</h2><p>You set the products, prices and stock. Staff sell from this list.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="owner-member-stats"><div class="card"><span>PRODUCTS</span><strong>${items.length}</strong><small>Tracked consumables</small></div><div class="card"><span>LOW STOCK</span><strong>${low.length}</strong><small>At or below threshold</small></div><div class="card"><span>OUT OF STOCK</span><strong>${items.filter(i => i.quantity === 0).length}</strong><small>Restock needed</small></div><div class="card"><span>SOLD TODAY</span><strong>${peso(sold)}</strong><small>${live.sales.filter(s => s.sold_on === phToday()).length} receipts</small></div></div>
      <section class="card owner-directory"><div class="panel-head"><div><div class="staff-kicker">CONSUMABLE PRODUCTS</div><h3>Stock and prices</h3><p>Only you can change products or pricing.</p></div><div style="display:flex;gap:8px"><button class="outline" id="stock-take-btn" style="height:38px">Stock-take</button><button class="login-submit" id="product-new" style="width:auto;height:38px;padding:0 16px">+ Add product</button></div></div>
        <div id="product-form-slot"></div>
        <div class="inventory-list">${items.map(item => `<div class="inventory-row"><span class="inventory-icon">${productIcon(item.name)}</span><div><strong>${esc(item.name)}</strong><small>${peso(item.price)} each${Number(item.cost) > 0 ? ` · costs ${peso(item.cost)}` : ''} · low-stock at ${item.threshold} ${esc(item.unit)}${item.supplier ? ` · ${esc(item.supplier)}` : ''}</small></div><span class="inventory-quantity-label"><b>${item.quantity}</b> ${esc(item.unit)}</span><span class="status-tag ${item.quantity === 0 ? 'status-deactivated' : item.quantity <= item.threshold ? 'status-expiring' : ''}">${item.quantity === 0 ? 'Out of stock' : item.quantity <= item.threshold ? 'Low stock' : 'In stock'}</span><div class="inventory-actions"><button class="outline restock-item" data-id="${item.id}">Restock</button><button class="outline stock-edit" data-id="${item.id}">Adjust</button><button class="outline price-edit" data-id="${item.id}">Price</button></div></div>`).join('') || '<p class="sub">No products yet. Add your first product.</p>'}</div>
      </section>
      <section class="card page-panel"><div class="panel-head"><div><h3>Recent stock movements</h3><p>Every adjustment and sale is logged.</p></div></div>${live.movements?.length ? live.movements.slice(0, 12).map(m => `<div class="attention-row"><div><strong>${esc(m.reason)}</strong><small>${esc(phDateTime(m.created_at))}</small></div><span>${m.delta > 0 ? '+' : ''}${m.delta}</span></div>`).join('') : '<p class="sub" style="padding:10px 0">Movement history is recorded as products are added and sold.</p>'}</section>`;
    ownerContent.querySelector('#product-new').onclick = () => productForm();
    ownerContent.querySelectorAll('.restock-item').forEach(button => button.onclick = () => restockDialog(button.dataset.id));
    ownerContent.querySelector('#stock-take-btn').onclick = () => stockTakeDialog();
    ownerContent.querySelectorAll('.stock-edit').forEach(button => button.onclick = () => editStock(button.dataset.id));
    ownerContent.querySelectorAll('.price-edit').forEach(button => button.onclick = () => editPrice(button.dataset.id));
  }

  function productForm() {
    const slot = ownerContent.querySelector('#product-form-slot');
    slot.innerHTML = `<form class="inventory-form" style="margin:14px 0"><label><span class="team-field-label">PRODUCT NAME</span><input class="login-input" id="p-name" required maxlength="80" placeholder="e.g. Bottled water"></label><label><span class="team-field-label">UNIT</span><input class="login-input" id="p-unit" required maxlength="30" placeholder="e.g. bottles"></label><label><span class="team-field-label">QUANTITY</span><input class="login-input" id="p-qty" type="number" min="0" step="1" value="0" required></label><label><span class="team-field-label">LOW-STOCK AT</span><input class="login-input" id="p-threshold" type="number" min="0" step="1" value="5" required></label><label><span class="team-field-label">PRICE (₱)</span><input class="login-input" id="p-price" type="number" min="0" step="0.01" required></label><button class="login-submit">Add product</button></form>`;
    slot.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      try {
        await ui.call('owner_set_product', {
          p_id: null,
          p_name: slot.querySelector('#p-name').value.trim(),
          p_unit: slot.querySelector('#p-unit').value.trim(),
          p_price: Number(slot.querySelector('#p-price').value),
          p_quantity: Number(slot.querySelector('#p-qty').value),
          p_threshold: Number(slot.querySelector('#p-threshold').value)
        });
        toastLive('Product added.');
        await refreshData(true);
        renderOwnerInventory();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  /* ---- Restock and stock-take ------------------------------------------ */
  function restockDialog(id) {
    const item = live.inventory.find(i => i.id === id);
    if (!item) return;
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">STOCK IN</div><h2>Restock ${esc(item.name)}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <div class="renew-expiry"><span>On hand now</span><strong>${item.quantity} ${esc(item.unit)}</strong></div>
      <label class="field" for="rs-qty">Quantity received</label><input class="login-input" id="rs-qty" type="number" min="1" step="1" value="10">
      <label class="field" for="rs-cost">Cost per ${esc(item.unit)} (₱)</label><input class="login-input" id="rs-cost" type="number" min="0" step="0.01" value="${Number(item.cost || 0)}">
      <label class="field" for="rs-supplier">Supplier</label><input class="login-input" id="rs-supplier" maxlength="80" value="${esc(item.supplier || '')}" placeholder="e.g. ABC Trading">
      <label class="field" for="rs-ref">Delivery reference</label><input class="login-input" id="rs-ref" maxlength="60" placeholder="e.g. DR-00124">
      <p class="renew-hint">Unit cost updates as a moving average, so your profit report stays accurate when prices change.</p>
      <div class="renew-actions"><button type="button" class="outline" id="rs-cancel">Cancel</button><button type="button" class="login-submit" id="rs-go">Add stock</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#rs-cancel').onclick = close;
    box.querySelector('#rs-go').onclick = async () => {
      const qty = Number(box.querySelector('#rs-qty').value);
      if (!qty || qty <= 0) return toastLive('Enter how many you received.');
      try {
        const row = await call('restock_item', {
          p_item_id: id, p_quantity: qty,
          p_unit_cost: Number(box.querySelector('#rs-cost').value || 0),
          p_supplier: box.querySelector('#rs-supplier').value.trim() || null,
          p_reference: box.querySelector('#rs-ref').value.trim() || null
        });
        close();
        toastLive(`Stock added — ${row.quantity} ${row.unit} on hand`);
        await refreshData(true); renderOwnerInventory();
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
    box.querySelector('#rs-qty').focus();
  }

  function stockTakeDialog() {
    const items = live.inventory.filter(i => i.is_active !== false);
    if (!items.length) return toastLive('Add a product first.');
    const box = document.createElement('dialog');
    box.className = 'renew-dialog stocktake-dialog';
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">PHYSICAL COUNT</div><h2>Stock-take</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <p class="sub">Count what's actually on the shelf. Anything that differs from the system is adjusted and recorded against your reason.</p>
      <div class="stocktake-list">${items.map(i => `<label class="stocktake-row"><span><b>${esc(i.name)}</b><small>system says ${i.quantity} ${esc(i.unit)}</small></span><input class="login-input" type="number" min="0" step="1" data-item="${i.id}" placeholder="${i.quantity}"></label>`).join('')}</div>
      <label class="field" for="st-reason">Reason for the count</label><input class="login-input" id="st-reason" maxlength="160" placeholder="e.g. monthly count, spillage found">
      <div class="renew-actions"><button type="button" class="outline" id="st-cancel">Cancel</button><button type="button" class="login-submit" id="st-go">Save count</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#st-cancel').onclick = close;
    box.querySelector('#st-go').onclick = async () => {
      const rows = [...box.querySelectorAll('input[data-item]')]
        .filter(input => input.value !== '')
        .map(input => ({ item_id: input.dataset.item, counted: Number(input.value) }));
      if (!rows.length) return toastLive('Enter at least one counted quantity.');
      const reason = box.querySelector('#st-reason').value.trim();
      if (reason.length < 3) return toastLive('Give a reason for the count.');
      try {
        const result = await call('record_stock_take', { p_items: rows, p_reason: reason });
        close();
        toastLive(result.adjusted
          ? `Count saved — ${result.counted} counted, ${result.adjusted} adjusted`
          : `Count saved — everything matched`);
        await refreshData(true); renderOwnerInventory();
      } catch (error) { toastLive(friendly(error)); }
    };
    box.showModal();
  }

  async function editStock(id) {
    const item = live.inventory.find(i => i.id === id);
    const value = await promptDialog({ title: `Set stock · ${item.name}`, body: 'Enter the actual counted quantity. The change is logged.', label: `Quantity (${item.unit})`, value: String(item.quantity), type: 'number' });
    if (value === null) return;
    try {
      await ui.call('owner_set_product', { p_id: id, p_name: item.name, p_unit: item.unit, p_price: Number(item.price), p_quantity: Number(value), p_threshold: item.threshold });
      toastLive('Stock updated.');
      await refreshData(true);
      renderOwnerInventory();
    } catch (error) { toastLive(friendly(error)); }
  }

  async function editPrice(id) {
    const item = live.inventory.find(i => i.id === id);
    const value = await promptDialog({ title: `Set price · ${item.name}`, body: 'The new price applies to the next sale.', label: 'Price (₱)', value: String(item.price), type: 'number' });
    if (value === null) return;
    try {
      await ui.call('owner_set_product', { p_id: id, p_name: item.name, p_unit: item.unit, p_price: Number(value), p_quantity: item.quantity, p_threshold: item.threshold });
      toastLive('Price updated.');
      await refreshData(true);
      renderOwnerInventory();
    } catch (error) { toastLive(friendly(error)); }
  }

  function renderOwnerSettings() {
    const setting = live.settings || {};
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">YOUR GYM, YOUR SETTINGS</div><h2>Settings</h2><p>Membership pricing and walk-in fees save to the shared database.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="owner-settings-layout"><section class="card owner-settings-main"><div class="panel-head"><div><div class="staff-kicker">MEMBERSHIP PLANS</div><h3>Set your pricing</h3><p>Prices prefill staff renewals. Amounts are in Philippine pesos.</p></div><span class="owner-panel-icon">₱</span></div>
        <form id="live-plans-form"><div class="plan-grid">${live.plans.map((p, i) => `<label class="plan-tile"><span class="plan-tile-top"><span class="plan-symbol">${['◷', '↗', '✳', '◌'][i % 4]}</span><span class="plan-period">${p.months === 12 ? 'ANNUAL' : 'MONTHLY'}</span></span><strong>${esc(p.label)}</strong><small>Membership plan</small><span class="plan-price-wrap"><span>₱</span><input class="plan-price" data-months="${p.months}" type="number" min="0" step="0.01" value="${Number(p.price || 0)}" required></span></label>`).join('')}</div>
        <div class="walkin-setting"><span class="plan-symbol">↗</span><div><strong>Walk-in fee</strong><small>Charged separately from memberships</small></div><label class="plan-price-wrap"><span>₱</span><input id="live-walkin" type="number" min="0" step="0.01" value="${setting.walkin_fee ?? ''}" placeholder="Not set"></label></div>
        <div class="settings-save"><p id="settings-note">Saved pricing applies to every staff account.</p><button type="submit" class="login-submit">Save pricing ↗</button></div></form></section>
      <aside class="card owner-settings-side"><div class="staff-kicker">SHARED WITH</div><h3>Both portals</h3><p>These values come from the same gym database used by staff and the member portal.</p>
        <div class="profile-section"><div class="profile-section-title">MEMBER PORTAL PAYMENTS</div><p class="sub" style="line-height:1.8">Choose which methods members can use when they submit a payment screenshot. The screenshot still waits for your verification.</p>
          ${[['GCash', 'GCash'], ['Bank transfer', 'Bank transfer'], ['E-wallet', 'E-wallet'], ['Other', 'Other']].map(([id, label]) => `<label style="display:flex;gap:9px;align-items:center;font-size:12px;color:#3d5542;margin:9px 0"><input type="checkbox" class="portal-method" value="${id}" ${(setting.member_payment_methods || []).some(m => m.id === id) ? 'checked' : ''}>${label}</label>`).join('')}
          <button class="outline" id="save-methods" style="margin-top:12px">Save payment methods</button></div>
        <div class="profile-section" style="margin-top:18px"><div class="profile-section-title">RECEIPT HEADER &amp; TAX</div>
          <p class="sub" style="line-height:1.8">Printed on every official receipt. Leave the TIN blank until you're registered.</p>
          <label class="field" for="biz-address">Business address</label><input class="login-input" id="biz-address" maxlength="160" value="${esc(setting.business_address || '')}" placeholder="e.g. 12 Hill St, Pasig City">
          <label class="field" for="biz-tin">TIN <em style="font-style:normal;color:#b3bcb4">(optional)</em></label><input class="login-input" id="biz-tin" maxlength="30" value="${esc(setting.tin || '')}" placeholder="000-000-000-00000">
          <label class="field" for="biz-rate">VAT rate (%)</label><input class="login-input" id="biz-rate" type="number" min="0" max="30" step="0.01" value="${Number(setting.vat_rate ?? 12)}">
          <label class="cash-confirm" style="margin-top:12px"><input type="checkbox" id="biz-vat" ${setting.vat_registered ? 'checked' : ''}><span class="cash-check" aria-hidden="true">✓</span><span>VAT registered — show VAT on receipts</span></label>
          <label class="field" for="biz-footer" style="margin-top:12px">Receipt footer</label><input class="login-input" id="biz-footer" maxlength="160" value="${esc(setting.receipt_footer || '')}" placeholder="Thank you. Train hard, recover harder.">
          <button class="outline" id="save-biz" style="margin-top:12px">Save receipt details</button></div>
        <div class="profile-section" style="margin-top:18px"><div class="profile-section-title">SYSTEM HEALTH</div>
          <div id="sys-health"><p class="sub">Checking…</p></div>
          <button class="outline" id="flush-queue" style="margin-top:10px">Send queued actions</button></div>
        <div class="settings-notice">✳ &nbsp; Walk-ins stay separate from membership revenue.</div></aside></div>`;
    ownerContent.querySelector('#save-methods').onclick = async () => {
      const chosen = [...ownerContent.querySelectorAll('.portal-method:checked')].map(input => ({ id: input.value, name: input.value }));
      try {
        await sb.from('gym_settings').update({ member_payment_methods: chosen }).eq('id', true);
        toastLive(chosen.length ? 'Member portal payment methods saved.' : 'No portal methods enabled — member proof submission is now unavailable.');
        await refreshData(true);
      } catch (error) { toastLive(friendly(error)); }
    };
    (async () => {
      const box = ownerContent.querySelector('#sys-health');
      const queued = readQueue().length;
      const { data: errs } = await sb.from('client_errors').select('id,message,created_at').order('created_at', { ascending: false }).limit(5);
      box.innerHTML = `<div class="profile-line"><span>Connection</span><strong>${navigator.onLine ? 'Online' : 'Offline'}</strong></div>
        <div class="profile-line"><span>Queued actions</span><strong>${queued}</strong></div>
        <div class="profile-line"><span>Reported errors</span><strong>${(errs || []).length}</strong></div>
        ${(errs || []).length ? `<div class="sys-errors">${errs.map(e => `<div><small>${esc(phDateTime(e.created_at))}</small> ${esc(String(e.message).slice(0, 90))}</div>`).join('')}</div>` : ''}`;
    })();
    ownerContent.querySelector('#flush-queue').onclick = async () => {
      const sent = await flushQueue();
      if (!sent) toastLive('Nothing queued.');
      renderOwnerSettings();
    };
    ownerContent.querySelector('#save-biz').onclick = async () => {
      try {
        await sb.from('gym_settings').update({
          business_address: ownerContent.querySelector('#biz-address').value.trim() || null,
          tin: ownerContent.querySelector('#biz-tin').value.trim() || null,
          vat_rate: Number(ownerContent.querySelector('#biz-rate').value || 0),
          vat_registered: ownerContent.querySelector('#biz-vat').checked,
          receipt_footer: ownerContent.querySelector('#biz-footer').value.trim() || null
        }).eq('id', true);
        toastLive('Receipt details saved.');
        await refreshData(true);
        renderOwnerSettings();
      } catch (error) { toastLive(friendly(error)); }
    };
    ownerContent.querySelector('#live-plans-form').onsubmit = async event => {
      event.preventDefault();
      try {
        for (const input of ownerContent.querySelectorAll('.plan-price')) {
          await sb.from('membership_plans').update({ price: Number(input.value) || 0 }).eq('months', Number(input.dataset.months));
        }
        const fee = ownerContent.querySelector('#live-walkin').value;
        await sb.from('gym_settings').update({ walkin_fee: fee === '' ? null : Number(fee) }).eq('id', true);
        toastLive('Pricing saved for all staff.');
        await refreshData(true);
        renderOwnerSettings();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  /* Staff views ----------------------------------------------------------- */
  const staffNav = staffShell.querySelector('.nav');

  function refreshStaff(tab) {
    const active = staffNav.querySelector('button.active');
    const view = tab || active?.dataset.staffTab || 'overview';
    if (view === 'members') renderStaffMembers();
    else if (view === 'walkins') renderStaffWalkins();
    else if (view === 'checkins') renderStaffCheckins();
    else if (view === 'inventory') renderStaffInventory();
    else renderStaffOverview();
    markLive(staffContent);
    revealNavigation(staffNav);
  }

  function staffHeading(kicker, title, sub) {
    return `<div class="section-head"><div><div class="eyebrow" style="color:#9baa96">${kicker}</div><h2>${title}</h2><p>${sub}</p></div><div class="updated"><span class="dot"></span> Live gym data</div></div>`;
  }

  function renderStaffOverview() {
    const s = summary();
    const todayVisits = live.visits.filter(v => v.visit_date === phToday());
    const open = live.visits.filter(v => !v.checked_out_at);
    const expiring = live.members.filter(m => m.expiring_soon);
    const firstName = (live.profile.full_name || (live.profile.email || '').split('@')[0] || 'there').trim().split(' ')[0];
    staffShell.querySelector('.intro h1').innerHTML = `Good day, <em>${esc(firstName)}.</em>`;
    staffShell.querySelector('.avatar').textContent = initials(live.profile.full_name || live.profile.email);
    const myShifts = (live.shifts || []).filter(sh => sh.staff_id === live.profile.id);
    const clockedIn = myShifts.find(sh => !sh.clocked_out_at);
    staffContent.innerHTML = `${staffHeading('YOUR DAY AT HILL', 'Operations overview', 'A live picture of what needs attention today.')}
      <div class="staff-metrics">
        <article class="card staff-metric"><div class="metric-icon">♙</div><div><div class="staff-metric-label">ACTIVE MEMBERS</div><strong>${s.active}</strong><small>${s.expiring || 0} expiring soon</small></div></article>
        <article class="card staff-metric"><div class="metric-icon">↗</div><div><div class="staff-metric-label">CHECK-INS TODAY</div><strong>${new Set(todayVisits.map(v => v.member_id)).size}</strong><small>${open.length} still checked in</small></div></article>
        <article class="card staff-metric"><div class="metric-icon">₱</div><div><div class="staff-metric-label">TODAY’S SALES</div><strong>${peso(live.payments.filter(p => p.paid_on === phToday()).reduce((n, p) => n + Number(p.amount), 0) + live.sales.filter(s2 => s2.sold_on === phToday()).reduce((n, s2) => n + Number(s2.total), 0) + live.walkins.filter(w => w.visited_on === phToday()).reduce((n, w) => n + Number(w.amount), 0))}</strong><small>Payments + products + walk-ins</small></div></article>
        <article class="card staff-metric"><div class="metric-icon">◷</div><div><div class="staff-metric-label">PENDING PAYMENTS</div><strong>${live.payments.filter(p => p.status === 'pending').length}</strong><small>Waiting for owner</small></div></article>
      </div>
      <section class="card staff-panel shift-panel"><div class="panel-head"><div><div class="staff-kicker">YOUR SHIFT</div><h3>${clockedIn ? 'On shift now' : 'Not clocked in'}</h3><p>${clockedIn ? 'Clocked in at ' + esc(chTime(clockedIn.clocked_in_at)) : 'Clock in when you start so the owner can see coverage.'}</p></div><button class="outline" id="shift-toggle">${clockedIn ? 'Clock out' : 'Clock in'}</button></div>${myShifts.length ? `<div class="shift-list">${myShifts.slice(0,4).map(sh => `<div class="attention-row"><div><strong>${esc(fmtDay(String(sh.clocked_in_at).slice(0,10)))}</strong><small>${esc(chTime(sh.clocked_in_at))} – ${sh.clocked_out_at ? esc(chTime(sh.clocked_out_at)) : 'still on shift'}</small></div><span>${sh.clocked_out_at ? Math.round((new Date(sh.clocked_out_at)-new Date(sh.clocked_in_at))/60000/60*10)/10 + ' h' : '—'}</span></div>`).join('')}</div>` : '<p class="sub">No shifts recorded yet.</p>'}</section>
      <div class="staff-overview-grid">
        <section class="card staff-panel"><div class="panel-head"><div><div class="staff-kicker">FRONT DESK</div><h3>Quick member lookup</h3><p>Find a member to check in or review their membership.</p></div></div><input class="login-input" id="quick" placeholder="Search name, ID or phone" aria-label="Search members"><div id="quick-results" class="quick-results"></div></section>
        <section class="card staff-panel"><div class="panel-head"><div><div class="staff-kicker">NEEDS ATTENTION</div><h3>Memberships</h3><p>Expired or expiring within 7 days.</p></div></div>${live.members.filter(m => m.expiring_soon || (m.expired && m.status === 'Active')).slice(0, 6).map(m => `<div class="attention-row"><div><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag status-expiring">Expiring</span><button class="outline staff-renew" data-id="${m.id}">Renew ↗</button></div>`).join('') || '<p class="sub">No memberships need attention.</p>'}</section>
      </div>
      <section class="card staff-panel"><div class="panel-head"><div><div class="staff-kicker">TODAY’S ACTIVITY</div><h3>What your team recorded</h3><p>Newest first · Philippine time.</p></div></div>${live.activity.slice(0, 8).map(a => `<div class="attention-row"><div><strong>${esc(a.summary)}</strong><small>${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</small></div></div>`).join('') || '<p class="sub">No activity yet.</p>'}</section>`;
    staffContent.querySelector('#shift-toggle').onclick = async () => {
      try {
        if (clockedIn) { await call('clock_out'); toastLive('Clocked out. Have a good one.'); }
        else { await call('clock_in'); toastLive('Clocked in. Have a great shift.'); }
        await refreshData(true); renderStaffOverview();
      } catch (error) { toastLive(friendly(error)); }
    };
    const input = staffContent.querySelector('#quick');
    const results = staffContent.querySelector('#quick-results');
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.innerHTML = '<p class="sub">Start typing to search members.</p>'; return; }
      const matches = live.members.filter(m => [m.full_name, m.member_no, m.phone].join(' ').toLowerCase().includes(q)).slice(0, 6);
      results.innerHTML = matches.map(m => `<div class="attention-row"><div><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'No plan')} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag ${m.effective_status === 'Active' ? '' : 'status-deactivated'}">${m.effective_status}</span><button class="outline quick-open" data-id="${m.id}">Open ↗</button></div>`).join('') || '<p class="sub">No members found.</p>';
      results.querySelectorAll('.quick-open').forEach(button => button.onclick = () => openStaffMember(button.dataset.id));
    };
    staffContent.querySelectorAll('.staff-renew').forEach(button => button.onclick = () => openRenewalLive(button.dataset.id));
  }

  function renderStaffMembers() {
    staffContent.innerHTML = `${staffHeading('YOUR COMMUNITY', 'Member directory', 'Find members, review status and request profile changes.')}
      <div class="card" style="margin-bottom:16px;display:flex;gap:12px;align-items:center"><input class="login-input" id="staff-search" placeholder="Search members by name, ID or phone"><button class="login-submit" id="staff-add" style="width:auto;white-space:nowrap;padding:0 20px">+ Add member</button></div><div id="staff-form-slot"></div><div id="staff-list"></div>`;
    const list = staffContent.querySelector('#staff-list');
    const search = staffContent.querySelector('#staff-search');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = live.members.filter(m => [m.full_name, m.member_no, m.phone, m.email].join(' ').toLowerCase().includes(q));
      if (!rows.length) {
        list.innerHTML = `<section class="card page-panel"><div class="panel-head"><div><h3>All members</h3><p>No members yet.</p></div></div><div class="attendance-empty" style="line-height:1.9">Your member list is empty. Use <strong>+ Add member</strong> above to register the first member — a member ID, expiry date and receipt are created automatically.</div></section>`;
        return;
      }
      list.innerHTML = `<section class="card page-panel"><div class="panel-head"><div><h3>All members</h3><p>${rows.length} member${rows.length === 1 ? '' : 's'} · newest first.</p></div></div>${rows.length ? rows.map(m => `<div class="attention-row"><div><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'No plan')} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag ${m.effective_status === 'Deactivated' ? 'status-deactivated' : m.expiring_soon ? 'status-expiring' : ''}">${m.effective_status === 'Deactivated' && m.expired ? 'Expired' : m.effective_status}</span><button class="outline staff-open" data-id="${m.id}">Open ↗</button></div>`).join('') : '<p class="sub">No members match your search.</p>'}</section>`;
      list.querySelectorAll('.staff-open').forEach(button => button.onclick = () => openStaffMember(button.dataset.id));
    };
    search.oninput = draw;
    draw();
    staffContent.querySelector('#staff-add').onclick = addMemberLive;
  }

  function openStaffMember(id) {
    const member = live.members.find(m => m.id === id);
    if (!member) return;
    const slot = staffContent.querySelector('#staff-form-slot') || staffContent.querySelector('#member-form-container');
    const payments = live.payments.filter(p => p.member_id === id);
    const visits = live.visits.filter(v => v.member_id === id);
    const form = document.createElement('section');
    form.className = 'card';
    form.style.marginBottom = '16px';
    form.innerHTML = `<div class="panel-head"><div><h3>${esc(member.full_name)} · ${esc(member.member_no)}</h3><p>Changes to member details need owner approval before they apply.</p></div><button class="outline close-profile">Close</button></div>
      <div class="profile-section"><div class="profile-section-title">MEMBERSHIP <span>${esc(member.plan_months ? planLabel(member.plan_months) : 'No plan')}</span></div>
        <div class="profile-line"><span>Status</span><strong>${esc(member.effective_status)}</strong></div>
        <div class="profile-line"><span>Start</span><strong>${esc(fmtDay(member.starts_on))}</strong></div>
        <div class="profile-line"><span>Expiry</span><strong>${esc(fmtDay(member.expires_on))}</strong></div></div>
      <div class="renew-actions" style="margin:12px 0"><button class="login-submit renew-now" style="width:auto;padding:0 18px">Record payment / renew ↗</button><button class="outline status-toggle">${member.status === 'Active' ? 'Deactivate member' : 'Reactivate member'}</button></div>
      <form class="profile-form"><div class="profile-section-title">REQUEST A CHANGE</div><label class="field">Full name</label><input class="login-input p-name" value="${esc(member.full_name)}"><label class="field">Mobile number</label><input class="login-input p-phone" value="${esc(member.phone || '')}"><label class="field">Email</label><input class="login-input p-email" value="${esc(member.email || '')}"><label class="field">Emergency contact</label><input class="login-input p-emergency" value="${esc(member.emergency_contact || '')}"><button class="outline" type="submit" style="margin-top:14px">Send for owner approval</button></form>
      <div class="profile-section"><div class="profile-section-title">PAYMENT HISTORY</div>${payments.length ? payments.map(p => `<div class="profile-history"><div>${esc(p.receipt_no)}<small>${esc(phDateTime(p.created_at))} · ${esc(p.method)} · ${esc(p.status)}</small></div><b>${peso(p.amount)}</b></div>`).join('') : '<p class="sub">No payments recorded.</p>'}</div>
      <div class="profile-section"><div class="profile-section-title">VISITS</div>${visits.slice(0, 8).map(v => `<div class="profile-history"><div>${esc(phDateTime(v.checked_in_at))}<small>${v.checked_out_at ? 'Out ' + esc(phDateTime(v.checked_out_at)) : 'Still inside'}</small></div></div>`).join('') || '<p class="sub">No visits recorded.</p>'}</div>`;
    slot.innerHTML = '';
    slot.append(form);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.querySelector('.close-profile').onclick = () => form.remove();
    form.querySelector('.renew-now').onclick = () => openRenewalLive(id);
    form.querySelector('.status-toggle').onclick = async () => {
      const next = member.status === 'Active' ? 'Deactivated' : 'Active';
      const ok = await confirmDialog({ title: next === 'Active' ? 'Reactivate this member?' : 'Deactivate this member?', body: next === 'Active' ? 'Reactivating lets them check in again. Confirm only after payment or an owner decision.' : 'Deactivated members can’t check in. The record and history stay available.', confirm: next === 'Active' ? 'Reactivate' : 'Deactivate' });
      if (!ok) return;
      try { await ui.call('set_member_status', { p_member_id: id, p_status: next, p_reason: null }); await refreshData(true); openStaffMember(id); } catch (error) { toastLive(friendly(error)); }
    };
    form.querySelector('.profile-form').onsubmit = async event => {
      event.preventDefault();
      const changes = {};
      const name = form.querySelector('.p-name').value.trim();
      const phone = form.querySelector('.p-phone').value.trim();
      const email = form.querySelector('.p-email').value.trim();
      const emergency = form.querySelector('.p-emergency').value.trim();
      if (name && name !== member.full_name) changes.full_name = name;
      if (phone !== (member.phone || '')) changes.phone = phone;
      if (email !== (member.email || '')) changes.email = email;
      if (emergency !== (member.emergency_contact || '')) changes.emergency_contact = emergency;
      if (!Object.keys(changes).length) return toastLive('No changes to send.');
      try {
        await ui.call('submit_profile_change', { p_member_id: id, p_changes: changes });
        toastLive('Change request sent to the owner.');
        await refreshData(true);
        form.querySelector('.profile-form').reset();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  function addMemberLive() {
    const slot = staffContent.querySelector('#staff-form-slot');
    const prices = Object.fromEntries(live.plans.map(p => [p.months, Number(p.price || 0)]));
    slot.innerHTML = `<form class="card" style="margin-bottom:16px"><div class="panel-head"><div><h3>Add a member</h3><p>Creates the member in the shared database and records the payment.</p></div><button type="button" class="outline cancel-add">Cancel</button></div>
      <label class="field">Full name *</label><input class="login-input" id="m-name" required maxlength="100" placeholder="Member’s full name">
      <label class="field">Mobile number *</label><input class="login-input" id="m-phone" type="tel" required maxlength="30">
      <label class="field">Email address</label><input class="login-input" id="m-email" type="email" placeholder="Used later for their member portal account">
      <label class="field">Membership plan *</label><select class="login-input" id="m-plan">${live.plans.map(p => `<option value="${p.months}" ${p.months === 3 ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
      <label class="field">Start date *</label><input class="login-input" id="m-start" type="date" value="${phToday()}" max="${phToday()}" required>
      <label class="field">Amount paid (₱) *</label><input class="login-input" id="m-amount" type="number" min="0" step="0.01" required value="${prices[3] || ''}">
      <label class="field">Payment method *</label><select class="login-input" id="m-method"><option value="Cash">Cash</option><option value="GCash">GCash</option><option value="Bank transfer">Bank transfer</option><option value="E-wallet">E-wallet</option><option value="Other">Other</option></select>
      <div id="m-ref-wrap" hidden><label class="field">Online transaction reference</label><input class="login-input" id="m-reference" maxlength="100"><p class="sub">Check the gym’s account independently. Online payments stay pending until the owner verifies them.</p></div>
      <label class="field">Emergency contact</label><input class="login-input" id="m-emergency" maxlength="100">
      <p class="sub" style="margin:12px 0">Your team gets a member ID automatically — HFG- followed by 6 unique digits, e.g. HFG-235211.</p>
      <button class="login-submit" style="width:auto;padding:0 22px">Create member ↗</button></form>`;
    slot.querySelector('.cancel-add').onclick = () => slot.innerHTML = '';
    slot.querySelector('#m-plan').onchange = event => { slot.querySelector('#m-amount').value = prices[event.target.value] || ''; };
    slot.querySelector('#m-method').onchange = event => {
      const online = event.target.value !== 'Cash';
      slot.querySelector('#m-ref-wrap').hidden = !online;
      slot.querySelector('#m-reference').required = online;
    };
    slot.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const name = slot.querySelector('#m-name').value.trim();
      const phone = slot.querySelector('#m-phone').value.trim();
      const email = slot.querySelector('#m-email').value.trim();
      const plan = Number(slot.querySelector('#m-plan').value);
      const start = slot.querySelector('#m-start').value;
      const amount = Number(slot.querySelector('#m-amount').value);
      const method = slot.querySelector('#m-method').value;
      const reference = slot.querySelector('#m-reference').value.trim();
      if (!name || !phone) return toastLive('Name and mobile number are required.');
      if (method !== 'Cash' && !reference) return toastLive('Enter the online payment reference.');
      if (!await confirmDialog({ title: 'Create this member?', body: `<b>${esc(name)}</b> · ${esc(planLabel(plan))} · ${peso(amount)} paid by ${esc(method)}.<br><br>Confirm the payment was received before saving.`, confirm: 'Create member' })) return;
      try {
        const created = await ui.call('create_member', { p_full_name: name, p_phone: phone, p_email: email || null, p_plan_months: plan, p_starts_on: start });
        await ui.call('record_membership_payment', { p_member_id: created.id, p_plan_months: plan, p_amount: amount, p_method: method, p_reference: reference || null, p_paid_on: start, p_description: method === 'Cash' ? 'New membership' : 'New membership · online payment' });
        toastLive(`${name} added · ${created.member_no}`);
        await refreshData(true);
        slot.innerHTML = '';
        renderStaffMembers();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  function openRenewalLive(memberId) {
    const member = live.members.find(m => m.id === memberId);
    if (!member) return;
    const dialog = document.querySelector('#renew-dialog');
    const form = document.querySelector('#renew-form');
    const prices = Object.fromEntries(live.plans.map(p => [p.months, Number(p.price || 0)]));
    document.querySelector('#renew-title').textContent = member.effective_status === 'Active' ? 'Record a renewal' : 'Renew membership';
    document.querySelector('#renew-member').textContent = `${member.full_name} · ${member.member_no} · currently expires ${fmtDay(member.expires_on)}`;
    form.reset();
    const duration = form.querySelector('#renew-duration');
    duration.value = member.plan_months || 3;
    form.querySelector('#renew-amount').value = prices[duration.value] || '';
    if (!form.querySelector('#renew-proof')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<label class="field" for="renew-proof">Payment screenshot (optional)</label><input class="login-input" id="renew-proof" type="file" accept="image/png,image/jpeg,image/webp" capture="environment"><p class="sub">Take a photo or choose a screenshot from the member’s phone. It is attached to the receipt record for the owner to verify.</p>';
      form.querySelector('#renew-reference-wrap').after(wrap);
    }
    const proofField = form.querySelector('#renew-proof');
    if (proofField) proofField.value = '';
    const preview = () => {
      const months = Number(duration.value);
      const base = member.expires_on && member.expires_on >= phToday() ? member.expires_on : phToday();
      const date = new Date(base + 'T00:00:00+08:00');
      const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
      const lastDay = new Date(target.getFullYear(), target.getMonth(), 0).getDate();
      const result = new Date(target.getFullYear(), target.getMonth() - 1, Math.min(date.getDate(), lastDay));
      form.querySelector('#renew-expiry').textContent = result.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    };
    duration.onchange = () => { form.querySelector('#renew-amount').value = prices[duration.value] || ''; preview(); };
    preview();
    const method = form.querySelector('#renew-method');
    method.onchange = () => {
      const online = method.value && method.value !== 'Cash';
      form.querySelector('#renew-reference-wrap').hidden = !online;
      form.querySelector('#renew-reference').required = !!online;
      form.querySelector('#renew-online-confirm').required = !!online;
    };
    method.onchange();
    form.onsubmit = async event => {
      event.preventDefault();
      const months = Number(duration.value);
      const amount = Number(form.querySelector('#renew-amount').value);
      const payMethod = method.value;
      const reference = form.querySelector('#renew-reference').value.trim();
      if (!payMethod) return toastLive('Choose a payment method.');
      if (payMethod !== 'Cash' && !reference) return toastLive('Enter the online payment reference.');
      try {
        let proofPath = null;
        const proofInput = form.querySelector('#renew-proof');
        const proofFile = proofInput?.files?.[0];
        if (proofFile) {
          if (!/^image\/(png|jpe?g|webp)$/.test(proofFile.type) || proofFile.size > 5 * 1024 * 1024) {
            return toastLive('Attach a PNG, JPG or WebP screenshot under 5 MB.');
          }
          const upload = await sb.storage.from('payment-proofs').upload(
            `${live.profile.id}/${member.id}-${Date.now()}.${proofFile.name.split('.').pop() || 'jpg'}`,
            proofFile,
            { contentType: proofFile.type, upsert: false }
          );
          if (upload.error) return toastLive('The screenshot could not be uploaded. Try again.');
          proofPath = upload.data.path;
        }
        const payment = await ui.call('record_membership_payment', { p_member_id: member.id, p_plan_months: months, p_amount: amount, p_method: payMethod, p_reference: reference || null, p_proof_path: proofPath, p_proof_source: proofPath ? 'staff' : null });
        dialog.close();
        toastLive(payment.status === 'pending' ? `Renewal saved · ${payment.receipt_no} · waiting for owner verification.` : `Membership renewed · ${payment.receipt_no} · now expires ${fmtDay(payment.new_expiry)}.`);
        await refreshData(true);
        refreshStaff();
      } catch (error) { toastLive(friendly(error)); }
    };
    dialog.querySelector('#renew-close').onclick = () => dialog.close();
    dialog.querySelector('#renew-cancel').onclick = () => dialog.close();
    dialog.showModal();
  }

  function renderStaffWalkins() {
    const fee = live.settings?.walkin_fee;
    const todays = live.walkins.filter(w => w.visited_on === phToday());
    staffContent.innerHTML = `${staffHeading('FRONT DESK', 'Walk-in visits', 'Recorded separately from memberships.')}
      <div class="walkin-layout"><section class="card staff-panel"><div class="panel-head"><div><div class="staff-kicker">NEW VISIT</div><h3>Record a walk-in</h3><p>Confirm payment before recording the visit.</p></div></div>
        <form id="walkin-live"><label class="field">Visitor name *</label><input class="login-input" id="w-name" required maxlength="100"><label class="field">Phone number</label><input class="login-input" id="w-phone" type="tel" maxlength="30">
        <div class="renew-expiry"><span>Walk-in fee</span><strong>${fee === null || fee === undefined ? 'Not set by owner' : peso(fee)}</strong></div>
        <label class="field">Payment method</label><select class="login-input" id="w-method"><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>E-wallet</option><option>Other</option></select>
        <div id="w-ref-wrap" hidden><label class="field">Online transaction reference</label><input class="login-input" id="w-reference" maxlength="100"><p class="sub">Check the gym’s account independently before confirming.</p></div>
        <label class="field">Amount received (₱)</label><input class="login-input" id="w-amount" type="number" min="0" step="0.01" value="${fee ?? ''}" required ${fee === null || fee === undefined ? 'disabled' : ''}>
        <button class="login-submit" style="margin-top:20px" ${fee === null || fee === undefined ? 'disabled' : ''}>Confirm visit ↗</button>
        <p class="sub">${fee === null || fee === undefined ? 'The owner must set a walk-in fee in Settings first.' : 'The owner sees this transaction in their dashboard.'}</p></form></section>
      <section class="card staff-panel"><div class="panel-head"><div><div class="staff-kicker">TODAY</div><h3>Today’s walk-ins</h3><p>${todays.length} recorded today.</p></div></div><div id="w-list">${todays.length ? todays.map(p => `<div class="attention-row"><div><strong>${esc(p.visitor_name)}</strong><small>${esc(p.receipt_no)} · ${esc(p.method)} · ${esc(chTime(p.created_at))}</small></div><span>${peso(p.amount)}</span></div>`).join('') : '<p class="sub">No walk-ins yet today.</p>'}</div></section></div>`;
    const method = staffContent.querySelector('#w-method');
    method.onchange = () => {
      const online = method.value !== 'Cash';
      staffContent.querySelector('#w-ref-wrap').hidden = !online;
      staffContent.querySelector('#w-reference').required = online;
    };
    staffContent.querySelector('#walkin-live').onsubmit = async event => {
      event.preventDefault();
      const name = staffContent.querySelector('#w-name').value.trim();
      const phone = staffContent.querySelector('#w-phone').value.trim();
      const amount = Number(staffContent.querySelector('#w-amount').value);
      const reference = staffContent.querySelector('#w-reference').value.trim();
      if (!name) return toastLive('Enter the visitor’s name.');
      if (method.value !== 'Cash' && !reference) return toastLive('Enter the online payment reference.');
      try {
        const row = await ui.call('record_walkin', { p_name: name, p_phone: phone || null, p_amount: amount, p_method: method.value, p_reference: reference || null });
        toastLive(`Walk-in recorded · ${row.receipt_no}`);
        await refreshData(true);
        renderStaffWalkins();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  function renderStaffCheckins() {
    const todayVisits = live.visits.filter(v => v.visit_date === phToday());
    const open = live.visits.filter(v => !v.checked_out_at);
    staffContent.innerHTML = `${staffHeading('MEMBER ENTRY', 'Member check-ins', 'Verify members and manage entry and exit activity.')}
      <div class="owner-member-stats attendance-stats"><div class="card"><span>UNIQUE MEMBERS TODAY</span><strong>${new Set(todayVisits.map(v => v.member_id)).size}</strong><small>Distinct member entries</small></div><div class="card"><span>CHECK-INS TODAY</span><strong>${todayVisits.length}</strong><small>Includes repeat visits</small></div><div class="card"><span>OPEN VISITS</span><strong>${open.length}</strong><small>Inside without checkout</small></div><div class="card"><span>EXPIRING SOON</span><strong>${live.members.filter(m => m.expiring_soon).length}</strong><small>Renew before entry</small></div></div>
      <div class="attendance-layout"><section class="card attendance-lookup"><div class="staff-kicker">MEMBER VERIFICATION</div><h3>Find a member</h3><p>Enter the member ID, or scan the QR from their member pass.</p><form id="att-lookup"><label class="field">Member ID</label><input class="login-input" id="att-id" placeholder="e.g. HFG-235211" required autocomplete="off"><button class="login-submit">Find member ↗</button></form><div class="attendance-note">✳ &nbsp; Verify identity and membership in person before confirming entry.</div></section>
      <section class="card attendance-current"><div class="panel-head"><div><div class="staff-kicker">OPEN VISITS</div><h3>Currently checked in</h3><p>Recorded visits without a checkout.</p></div><span class="status-tag">${open.length} open</span></div>${open.length ? open.map(v => { const m = live.members.find(x => x.id === v.member_id); return `<div class="attendance-row"><span class="attendance-icon">↗</span><div><strong>${esc(m?.full_name || 'Member')}</strong><small>${esc(m?.member_no || '')} · In ${esc(phDateTime(v.checked_in_at))}</small></div><button class="outline att-correct" data-visit="${v.id}">Correct exit</button><button class="outline att-out" data-member="${v.member_id}">Check out</button></div>`; }).join('') : '<div class="attendance-empty">No open visits right now.</div>'}</section></div>
      <section class="card attendance-activity"><div class="panel-head"><div><div class="staff-kicker">THE ACTIVITY LOG</div><h3>Recent activity</h3><p>Check-ins and checkouts · Philippine time.</p></div></div>${live.visits.slice(0, 12).map(v => { const m = live.members.find(x => x.id === v.member_id); return `<div class="attendance-row"><span class="attendance-icon ${v.checked_out_at ? 'exit' : ''}">${v.checked_out_at ? '↙' : '↗'}</span><div><strong>${esc(m?.full_name || 'Member')} · ${v.checked_out_at ? 'Checkout' : 'Check-in'}</strong><small>${esc(m?.member_no || '')} · ${esc(phDateTime(v.checked_out_at || v.checked_in_at))}</small></div></div>`; }).join('') || '<div class="attendance-empty">No entry or exit activity yet.</div>'}</section>`;
    staffContent.querySelector('#att-lookup').onsubmit = async event => {
      event.preventDefault();
      const raw = staffContent.querySelector('#att-id').value.trim();
      let member = null;
      if (raw.toUpperCase().startsWith('GIMMDA:')) {
        const code = raw.split(':').pop();
        try {
          const scanned = await ui.call('validate_member_pass', { p_code: code });
          member = live.members.find(m => m.id === scanned.member_id);
          toastLive(`${scanned.full_name} · pass verified.`);
        } catch (error) {
          const passMessages = {
            PASS_INVALID: 'This pass is not valid. Ask the member to refresh their pass.',
            PASS_USED: 'This pass was already used. Ask the member to refresh their pass.',
            PASS_EXPIRED: 'This pass expired. Ask the member to refresh their pass.'
          };
          const message = String(error?.message || '');
          const key = Object.keys(passMessages).find(code2 => message.includes(code2));
          return toastLive(key ? passMessages[key] : friendly(error));
        }
      } else {
        member = live.members.find(m => m.member_no.toUpperCase() === raw.toUpperCase());
      }
      if (!member) return toastLive('Member not found. Check the ID and try again.');
      const openVisit = live.visits.find(v => v.member_id === member.id && !v.checked_out_at);
      if (openVisit) {
        if (!await confirmDialog({ title: 'Confirm checkout', body: `<b>${esc(member.full_name)}</b> is still recorded inside since ${esc(phDateTime(openVisit.checked_in_at))}.`, confirm: 'Record checkout' })) return;
        try { await ui.call('check_out', { p_member_id: member.id }); toastLive('Checkout recorded.'); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
        return;
      }
      if (member.effective_status !== 'Active') return toastLive('This membership is not active. Renew it before check-in.');
      if (!await confirmDialog({ title: 'Confirm check-in', body: `<b>${esc(member.full_name)}</b> · ${esc(member.member_no)}<br>Plan expires ${esc(fmtDay(member.expires_on))}.<br><br>Confirm the member’s identity before entry.`, confirm: 'Check in' })) return;
      try { await ui.call('check_in', { p_member_id: member.id }); toastLive('Check-in recorded.'); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
    };
    staffContent.querySelectorAll('.att-out').forEach(button => button.onclick = async () => {
      try { await ui.call('check_out', { p_member_id: button.dataset.member }); toastLive('Checkout recorded.'); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
    });
    staffContent.querySelectorAll('.att-correct').forEach(button => button.onclick = () => correctVisit(button.dataset.visit));
  }

  async function correctVisit(visitId) {
    const visit = live.visits.find(v => v.id === visitId);
    const member = live.members.find(m => m.id === visit?.member_id);
    const time = await promptDialog({ title: 'Correct checkout time', body: `For <b>${esc(member?.full_name || 'member')}</b>, checked in ${esc(phDateTime(visit?.checked_in_at))}. Enter the actual exit time (Philippine time).`, label: 'Exit time', type: 'datetime-local', value: new Date().toISOString().slice(0, 16) });
    if (!time) return;
    const reason = await promptDialog({ title: 'Why is this being corrected?', body: 'The reason is saved with the visit and shown to the owner.', label: 'Reason', value: '' });
    if (!reason) return;
    try {
      await ui.call('correct_checkout', { p_visit_id: visitId, p_checked_out_at: new Date(time).toISOString(), p_reason: reason });
      toastLive('Checkout correction saved.');
      await refreshData(true);
      renderStaffCheckins();
    } catch (error) { toastLive(friendly(error)); }
  }

  function renderStaffInventory() {
    const items = live.inventory.filter(i => i.is_active);
    const low = items.filter(i => i.quantity <= i.threshold);
    staffContent.innerHTML = `${staffHeading('THE GYM SHOP', 'Product sales', 'Select products, confirm payment and issue an e-receipt.')}
      <div class="owner-member-stats inventory-stats"><div class="card"><span>PRODUCTS</span><strong>${items.length}</strong><small>Available for sale</small></div><div class="card"><span>LOW STOCK</span><strong>${low.length}</strong><small>At or below threshold</small></div><div class="card"><span>OUT OF STOCK</span><strong>${items.filter(i => i.quantity === 0).length}</strong><small>Restock needed</small></div><div class="card"><span>RECEIPTS TODAY</span><strong>${live.sales.filter(s => s.sold_on === phToday()).length}</strong><small>Product sales</small></div></div>
      <section class="card owner-directory"><div class="panel-head"><div><div class="staff-kicker">POINT OF SALE</div><h3>Sale cart</h3><p>Add products to the cart — the total and change update automatically.</p></div><button class="outline clear-cart">Clear cart</button></div>
        <div class="inventory-list">${items.map(item => `<div class="inventory-row"><span class="inventory-icon">${productIcon(item.name)}</span><div><strong>${esc(item.name)}</strong><small>${peso(item.price)} each · ${item.quantity} ${esc(item.unit)} in stock</small></div><span class="status-tag ${item.quantity <= item.threshold ? 'status-expiring' : ''}">${item.quantity === 0 ? 'Out of stock' : item.quantity <= item.threshold ? 'Low stock' : 'In stock'}</span><div class="inventory-actions"><button class="outline add-to-cart" data-id="${item.id}" ${item.quantity === 0 ? 'disabled' : ''}>Add to cart</button></div></div>`).join('') || '<p class="sub">No products yet. The owner adds products in their inventory page.</p>'}</div>
        <div id="cart-panel" class="cart-panel" hidden></div></section>`;
    staffContent.querySelector('.clear-cart').onclick = () => { cart.clear(); drawCart(); };
    staffContent.querySelectorAll('.add-to-cart').forEach(button => button.onclick = () => {
      const item = items.find(i => i.id === button.dataset.id);
      const line = cart.get(item.id);
      if (!line) cart.set(item.id, { item, quantity: 1 });
      else if (line.quantity < item.quantity) line.quantity += 1;
      else return toastLive(`Only ${item.quantity} ${item.unit} available.`);
      drawCart();
    });
  }

  const cart = new Map();

  function drawCart() {
    const panel = staffContent.querySelector('#cart-panel');
    if (!panel) return;
    if (!cart.size) { panel.hidden = true; return; }
    panel.hidden = false;
    const lines = [...cart.values()];
    const subtotal = lines.reduce((n, l) => n + Number(l.item.price) * l.quantity, 0);
    panel.innerHTML = `<div class="staff-kicker">CART</div>${lines.map(l => `<div class="attention-row"><div><strong>${esc(l.item.name)}</strong><small>${peso(l.item.price)} each · ${l.quantity} ×</small></div><span>${peso(Number(l.item.price) * l.quantity)}</span><button class="outline qty-minus" data-id="${l.item.id}">−</button><button class="outline qty-plus" data-id="${l.item.id}">+</button></div>`).join('')}
      <div class="renew-expiry"><span>Total</span><strong id="cart-total">${peso(subtotal)}</strong></div>
      <label class="field">Customer name (optional)</label><input class="login-input" id="cart-customer" placeholder="Walk-in customer">
      <label class="field">Payment method</label><select class="login-input" id="cart-method"><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>E-wallet</option><option>Other</option></select>
      <div id="cart-online" hidden><label class="field">Online transaction reference</label><input class="login-input" id="cart-ref" maxlength="100"></div>
      <div id="cart-cash"><label class="field">Cash received (₱)</label><input class="login-input" id="cash-received" type="number" min="0" step="0.01" value="${subtotal.toFixed(2)}"><p class="sub" id="change-due">Change due: ₱0.00</p></div>
      <button class="login-submit" id="complete-sale" style="margin-top:14px">Complete sale ↗</button>`;
    panel.querySelectorAll('.qty-minus').forEach(button => button.onclick = () => {
      const line = cart.get(button.dataset.id);
      if (line.quantity <= 1) cart.delete(button.dataset.id);
      else line.quantity -= 1;
      drawCart();
    });
    panel.querySelectorAll('.qty-plus').forEach(button => button.onclick = () => {
      const line = cart.get(button.dataset.id);
      if (line.quantity >= line.item.quantity) return toastLive(`Only ${line.item.quantity} ${line.item.unit} available.`);
      line.quantity += 1;
      drawCart();
    });
    const method = panel.querySelector('#cart-method');
    const cash = panel.querySelector('#cart-cash');
    const online = panel.querySelector('#cart-online');
    const received = panel.querySelector('#cash-received');
    method.onchange = () => {
      const isCash = method.value === 'Cash';
      cash.hidden = !isCash;
      online.hidden = isCash;
      panel.querySelector('#cart-ref').required = !isCash;
    };
    received.oninput = () => {
      const change = Number(received.value || 0) - subtotal;
      panel.querySelector('#change-due').textContent = `Change due: ${change >= 0 ? peso(change) : 'cash is short by ' + peso(Math.abs(change))}`;
    };
    panel.querySelector('#complete-sale').onclick = async () => {
      const methodValue = method.value;
      const reference = panel.querySelector('#cart-ref').value.trim();
      if (methodValue !== 'Cash' && !reference) return toastLive('Enter the online payment reference.');
      const cashValue = Number(received.value || 0);
      if (methodValue === 'Cash' && cashValue < subtotal) return toastLive('Cash received is less than the total.');
      try {
        const sale = await ui.call('record_product_sale', {
          p_items: lines.map(l => ({ item_id: l.item.id, quantity: l.quantity })),
          p_method: methodValue,
          p_reference: reference || null,
          p_customer: panel.querySelector('#cart-customer').value.trim() || null,
          p_cash_received: methodValue === 'Cash' ? cashValue : null
        });
        cart.clear();
        showEreceipt(sale, lines, methodValue);
        await refreshData(true);
        renderStaffInventory();
      } catch (error) { toastLive(friendly(error)); }
    };
    staffContent.querySelector('#cart-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function productIcon(name) {
    const label = name.toLowerCase();
    let inner;
    if (/water|bottle/.test(label)) inner = '<path d="M9 3h6M10 3v3l-2 2v10a3 3 0 0 0 3 3h2a3 3 0 0 0 3-3V8l-2-2V3M8 11h8M8 16h8"/>';
    else if (/bar|protein|snack/.test(label)) inner = '<rect x="5" y="7" width="14" height="10" rx="2"/><path d="M5 9H3m16 0h2M5 15H3m16 0h2M9 10l6 4m-6 0 6-4"/>';
    else if (/drink|soda|juice|can/.test(label)) inner = '<path d="M8 4h8l1 3-1 12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2L7 7l1-3ZM8 7h8M9 4h6M9 17h6"/>';
    else inner = '<path d="M4 8 12 4l8 4v9l-8 4-8-4V8Zm0 0 8 4 8-4M12 12v9M8 6l8 4"/>';
    return `<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
  }

  function showEreceipt(sale, lines, method) {
    const total = lines.reduce((n, l) => n + Number(l.item.price) * l.quantity, 0);
    const change = Math.max(0, Number(sale.change_due || 0));
    const body = `<b>${esc(sale.receipt_no)}</b> · ${esc(phDateTime(new Date().toISOString()))}<br>${lines.map(l => `${esc(l.item.name)} ×${l.quantity} — ${peso(Number(l.item.price) * l.quantity)}`).join('<br>')}<br><br>Total: <b>${peso(total)}</b><br>Paid by ${esc(method)}${method === 'Cash' ? ' · change ' + peso(change) : ''}`;
    const tax = { vat: sale.vat_amount, net: sale.net_of_tax };
    dialog({ title: 'Sale complete · e-receipt', body, action: 'Print 80mm receipt', onAction: () => {
      printReceipt({
        title: 'PRODUCT SALE', orNo: sale.or_no || sale.receipt_no,
        lines: lines.map(l => ({ label: `${l.item.name} x${l.quantity}`, amount: Number(l.item.price) * l.quantity })),
        total, method, cash: sale.cash_received, change: sale.change_due,
        tax, customer: sale.customer_name, date: phDateTime(new Date().toISOString())
      });
    }, cancel: 'Download instead', onCancel: () => {
      const html = `<!doctype html><meta charset="utf-8"><title>${esc(sale.receipt_no)}</title><style>body{font:14px system-ui;padding:32px;color:#20301f}h1{font:700 22px Georgia}h2{font:700 14px system-ui}.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #e6ece3}</style><h2>GIMMDA | HILL FITNESS GYM</h2><h1>Product receipt</h1><p>${esc(sale.receipt_no)} · ${esc(phDateTime(new Date().toISOString()))}</p>${lines.map(l => `<div class="row"><span>${esc(l.item.name)} ×${l.quantity}</span><strong>${peso(Number(l.item.price) * l.quantity)}</strong></div>`).join('')}<div class="row"><span>Total</span><strong>${peso(total)}</strong></div><div class="row"><span>Payment</span><strong>${esc(method)}</strong></div>${method === 'Cash' ? `<div class="row"><span>Change</span><strong>${peso(change)}</strong></div>` : ''}`;
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `receipt-${sale.receipt_no}.html`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }});
  }

  /* Negative money must not read "₱-450.00" — Philippine books write (450.00). */
  function signedPeso(value) {
    const n = Number(value || 0);
    return n < 0 ? '−' + peso(Math.abs(n)) : peso(n);
  }

  /* ---- Finance: expenses, profit, VAT ---------------------------------- */
  function renderOwnerFinance() {
    const range = live.period === 'week' ? ui.weekRange() : ui.monthRange();
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">MONEY IN, MONEY OUT</div><h2>Finance</h2><p>What the gym earned, what it spent, and what's actually left.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div id="finance-body"><p class="sub">Working out your numbers…</p></div>`;
    loadFinance(range);
  }

  async function loadFinance(range) {
    const body = ownerContent.querySelector('#finance-body');
    if (!body) return;
    let report;
    try {
      report = await call('profit_report', { p_from: range.from, p_to: range.to });
    } catch (error) {
      body.innerHTML = `<p class="sub">${esc(friendly(error))}</p>`;
      return;
    }
    const { data: expenses } = await sb.from('expenses').select('*').gte('spent_on', range.from).lte('spent_on', range.to).order('spent_on', { ascending: false });
    const rev = report.revenue, exp = report.expenses;
    const liveExpenses = (expenses || []).filter(e => !e.voided_at);
    const label = live.period === 'week' ? 'This week' : 'This month';
    const maxBar = Math.max(1, ...report.series.map(d => Math.max(Number(d.revenue), Number(d.expenses))));

    body.innerHTML = `
      <div class="finance-grid">
        <div class="card finance-stat"><span>REVENUE</span><strong>${peso(rev.total)}</strong><small>${label} · all sources</small></div>
        <div class="card finance-stat"><span>EXPENSES</span><strong class="is-cost">${peso(exp.total)}</strong><small>${liveExpenses.length} entries</small></div>
        <div class="card finance-stat"><span>PROFIT</span><strong class="${Number(report.net_profit) >= 0 ? 'is-profit' : 'is-loss'}">${signedPeso(report.net_profit)}</strong><small>After cost of goods and expenses</small></div>
        <div class="card finance-stat"><span>VAT COLLECTED</span><strong>${peso(report.vat_collected)}</strong><small>${live.settings?.vat_registered ? 'Registered · set aside this' : 'Not VAT registered'}</small></div>
      </div>

      <section class="card page-panel">
        <div class="panel-head"><div><h3>Where the money came from</h3><p>${label}, before costs.</p></div></div>
        <div class="finance-split">
          <div><span>Memberships</span><strong>${peso(rev.membership)}</strong></div>
          <div><span>Walk-ins</span><strong>${peso(rev.walkin)}</strong></div>
          <div><span>Products</span><strong>${peso(rev.product)}</strong></div>
          <div><span>Other</span><strong>${peso(rev.other)}</strong></div>
        </div>
        <div class="finance-waterfall">
          <div class="wf-row"><span>Revenue</span><strong>${peso(rev.total)}</strong></div>
          <div class="wf-row is-cost"><span>Cost of goods sold</span><strong>−${peso(Math.abs(Number(report.cogs)))}</strong></div>
          <div class="wf-row"><span>Gross profit</span><strong>${signedPeso(report.gross_profit)}</strong></div>
          <div class="wf-row is-cost"><span>Operating expenses</span><strong>−${peso(Math.abs(Number(exp.total)))}</strong></div>
          <div class="wf-row wf-total"><span>Net profit</span><strong>${signedPeso(report.net_profit)}</strong></div>
        </div>
      </section>

      <section class="card page-panel">
        <div class="panel-head"><div><h3>Daily trend</h3><p>Revenue against what you spent, day by day.</p></div></div>
        <div class="finance-chart">${report.series.map(d => `<div class="fc-col" title="${esc(d.date)} · in ${peso(d.revenue)} · out ${peso(d.expenses)}"><div class="fc-bars"><i class="fc-in" style="height:${Math.max(2, (Number(d.revenue) / maxBar) * 100)}%"></i><i class="fc-out" style="height:${Math.max(2, (Number(d.expenses) / maxBar) * 100)}%"></i></div><small>${esc(String(d.date).slice(8))}</small></div>`).join('')}</div>
        <div class="fc-legend"><span><i class="fc-in"></i> Revenue</span><span><i class="fc-out"></i> Expenses</span></div>
      </section>

      <section class="card page-panel">
        <div class="panel-head"><div><h3>Expenses</h3><p>Rent, bills, salaries — everything that leaves the till.</p></div><button class="login-submit" id="expense-new" style="width:auto;height:38px;padding:0 16px">+ Record expense</button></div>
        <div id="expense-form-slot"></div>
        ${liveExpenses.length ? `<div class="expense-list">${liveExpenses.map(e => `<div class="expense-row${e.voided_at ? ' row-is-voided' : ''}"><div><strong>${esc(e.description)}</strong><small>${esc(e.category)} · ${esc(fmtDay(e.spent_on))}${e.vendor ? ' · ' + esc(e.vendor) : ''} · ${esc(e.method)}${e.paid_from_drawer ? ' (drawer)' : ''}</small></div><span>${peso(e.amount)}</span>${e.voided_at ? `<small class="void-reason">${esc(e.void_reason || 'voided')}</small>` : `<button class="outline expense-void" data-id="${e.id}" data-desc="${esc(e.description)}">Void</button>`}</div>`).join('')}</div>` : '<p class="sub" style="padding:12px 0">No expenses recorded for this period.</p>'}
      </section>

      <div class="finance-foot"><button class="outline" id="finance-export">Export profit report (CSV)</button><button class="outline" id="finance-tax">Tax summary (BIR)</button></div>`;

    const refresh = () => loadFinance(range);
    // The await above may have outlived this render (the user switched tabs), in which
    // case these elements no longer exist. Never assume they survived.
    const newNode = ownerContent.querySelector('#expense-new');
    if (!newNode || !body.isConnected) return;
    newNode.onclick = () => expenseForm(range, refresh);
    ownerContent.querySelectorAll('.expense-void').forEach(b => b.onclick = async () => {
      const reason = await askReason(`Void "${b.dataset.desc}"`, 'Why is this expense being voided?');
      if (!reason) return;
      try { await call('void_expense', { p_expense_id: b.dataset.id, p_reason: reason }); toastLive('Expense voided'); refresh(); }
      catch (error) { toastLive(friendly(error)); }
    });
    const exportBtn = ownerContent.querySelector('#finance-export');
    const taxBtn = ownerContent.querySelector('#finance-tax');
    if (!exportBtn || !taxBtn) return;
    exportBtn.onclick = () => downloadCsv('gimmda-profit.csv', [
      ['Section', 'Item', 'Amount'], ['Revenue', 'Memberships', rev.membership], ['Revenue', 'Walk-ins', rev.walkin],
      ['Revenue', 'Products', rev.product], ['Revenue', 'Other', rev.other], ['Revenue', 'TOTAL', rev.total],
      ['Cost', 'Cost of goods sold', report.cogs], ['Cost', 'Gross profit', report.gross_profit],
      ...(exp.by_category || []).map(c => ['Expense', c.category, c.total]),
      ['Expense', 'TOTAL EXPENSES', exp.total], ['Profit', 'NET PROFIT', report.net_profit],
      ['Tax', 'VAT collected', report.vat_collected], [], ['Date', 'Revenue', 'Expenses'],
      ...report.series.map(d => [d.date, d.revenue, d.expenses])
    ]);
    taxBtn.onclick = () => taxSummary(report, range);
  }

  function expenseForm(range, refresh) {
    const slot = ownerContent.querySelector('#expense-form-slot');
    const cats = ['Rent','Utilities','Salaries','Equipment','Repairs','Supplies','Marketing','Taxes','Permits','Other'];
    slot.innerHTML = `<form class="expense-form" id="expense-form">
      <div class="expense-form-grid">
        <label><span>What was it for?</span><input class="login-input" id="exp-desc" required maxlength="160" placeholder="e.g. Meralco bill"></label>
        <label><span>Category</span><select class="login-input" id="exp-cat">${cats.map(c => `<option>${c}</option>`).join('')}</select></label>
        <label><span>Amount (₱)</span><input class="login-input" id="exp-amount" type="number" min="0.01" step="0.01" required></label>
        <label><span>Paid with</span><select class="login-input" id="exp-method"><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>E-wallet</option><option>Other</option></select></label>
        <label><span>Vendor <em>(optional)</em></span><input class="login-input" id="exp-vendor" maxlength="80"></label>
        <label><span>Date</span><input class="login-input" id="exp-date" type="date" value="${phToday()}" max="${phToday()}"></label>
      </div>
      <label class="cash-confirm"><input type="checkbox" id="exp-drawer" checked><span class="cash-check" aria-hidden="true">✓</span><span>Paid out of today's cash drawer</span></label>
      <div class="expense-form-actions"><button type="button" class="outline" id="exp-cancel">Cancel</button><button type="submit" class="login-submit" style="width:auto;height:38px;padding:0 18px">Save expense</button></div>
      <p class="sub">Cash expenses reduce the expected drawer total on the day they're dated.</p></form>`;
    slot.querySelector('#exp-cancel').onclick = () => { slot.innerHTML = ''; };
    slot.querySelector('#exp-method').onchange = event => {
      if (event.target.value !== 'Cash') { slot.querySelector('#exp-drawer').checked = false; slot.querySelector('#exp-drawer').disabled = true; }
      else { slot.querySelector('#exp-drawer').disabled = false; }
    };
    slot.querySelector('#expense-form').onsubmit = async event => {
      event.preventDefault();
      const btn = slot.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await call('record_expense', {
          p_category: slot.querySelector('#exp-cat').value,
          p_description: slot.querySelector('#exp-desc').value.trim(),
          p_amount: Number(slot.querySelector('#exp-amount').value),
          p_method: slot.querySelector('#exp-method').value,
          p_vendor: slot.querySelector('#exp-vendor').value.trim() || null,
          p_spent_on: slot.querySelector('#exp-date').value || phToday(),
          p_from_drawer: slot.querySelector('#exp-drawer').checked
        });
        toastLive('Expense recorded');
        refresh();
      } catch (error) { btn.disabled = false; toastLive(friendly(error)); }
    };
    slot.querySelector('#exp-desc').focus();
  }

  function taxSummary(report, range) {
    const vat = Number(report.vat_collected);
    const net = Number(report.revenue.total) - vat;
    dialog({
      title: 'Tax summary',
      body: `<p style="margin:0 0 14px">For <b>${esc(range.from)}</b> to <b>${esc(range.to)}</b>. Figures come from your recorded receipts.</p>
        <div class="wf-row"><span>Gross receipts</span><strong>${peso(report.revenue.total)}</strong></div>
        <div class="wf-row"><span>Net of VAT</span><strong>${peso(net)}</strong></div>
        <div class="wf-row"><span>Output VAT collected</span><strong>${peso(vat)}</strong></div>
        <div class="wf-row"><span>Deductible expenses</span><strong>${peso(report.expenses.total)}</strong></div>
        <div class="wf-row wf-total"><span>Taxable income</span><strong>${signedPeso(report.net_profit)}</strong></div>
        <p class="sub" style="margin-top:14px">This is a summary to hand to your accountant, not a filed return. BIR rules depend on your registration — check with them before filing.</p>`,
      action: 'Download CSV',
      onAction: () => downloadCsv('gimmda-tax-summary.csv', [
        ['Item', 'Amount'], ['Period', `${range.from} to ${range.to}`],
        ['Gross receipts', report.revenue.total], ['Net of VAT', net], ['Output VAT', vat],
        ['Total expenses', report.expenses.total], ['Taxable income', report.net_profit]
      ])
    });
  }

  /* ---- Cash: the daily drawer close ------------------------------------ */
  function renderOwnerCash() {
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">END OF DAY</div><h2>Cash drawer</h2><p>Count the drawer, compare it with what the records say, and close the day.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div id="cash-body"><p class="sub">Opening today's drawer…</p></div>`;
    loadCash();
  }

  async function loadCash() {
    const body = ownerContent.querySelector('#cash-body');
    if (!body) return;
    const date = ownerContent.querySelector('#cash-date')?.value || phToday();
    let s;
    try { s = await call('cash_day_summary', { p_date: date }); }
    catch (error) { body.innerHTML = `<p class="sub">${esc(friendly(error))}</p>`; return; }
    const closed = !!s.closed;
    const perId = v => Number(v || 0);
    body.innerHTML = `
      <div class="cash-date-bar">
        <label class="cash-date-field">Business date <input class="login-input" type="date" id="cash-date" value="${esc(date)}" max="${phToday()}"></label>
        <span class="status-tag ${closed ? 'status-expiring' : ''}">${closed ? 'Closed' : 'Open'}</span>
      </div>
      <div class="finance-grid">
        <div class="card finance-stat finance-stat-input${!closed && !s.opening_seeded ? ' needs-float' : ''}"><span>OPENING FLOAT</span>${closed ? `<strong>${peso(perId(s.opening_float))}</strong><small>Locked — day closed</small>` : `<div class="float-edit"><span>₱</span><input class="login-input" id="cash-float" type="number" min="0" step="0.01" value="${perId(s.opening_float)}"><button class="outline" id="cash-save-float">Save</button></div><small>${s.opening_seeded ? 'Cash in the drawer at start' : 'Not set yet — enter what the drawer started with'}</small>`}</div>
        <div class="card finance-stat"><span>CASH IN</span><strong class="is-profit">+${peso(perId(s.cash_in))}</strong><small>Memberships, walk-ins, products</small></div>
        <div class="card finance-stat"><span>CASH OUT</span><strong class="is-cost">−${peso(perId(s.cash_out))}</strong><small>Expenses paid from drawer</small></div>
        <div class="card finance-stat"><span>SHOULD BE IN DRAWER</span><strong>${peso(Math.max(0, perId(s.expected_cash)))}</strong><small>${perId(s.expected_cash) < 0 ? 'Short — set the opening float' : 'Float + in − out'}</small></div>
      </div>
      ${closed ? `
        <section class="card page-panel cash-closed">
          <div class="panel-head"><div><h3>Day closed</h3><p>${esc(fmtDay(date))} · counted ${peso(perId(s.counted_cash))}</p></div></div>
          <div class="wf-row"><span>Expected</span><strong>${peso(perId(s.expected_cash))}</strong></div>
          <div class="wf-row"><span>Counted</span><strong>${peso(perId(s.counted_cash))}</strong></div>
          <div class="wf-row ${Number(s.variance) === 0 ? '' : 'is-cost'}"><span>Difference</span><strong>${Number(s.variance) > 0 ? '+' : ''}${Number(s.variance) < 0 ? '−' + peso(Math.abs(Number(s.variance))) : peso(perId(s.variance))}</strong></div>
          <p class="sub" style="margin-top:12px">${Number(s.variance) === 0 ? 'The drawer matched exactly.' : Number(s.variance) > 0 ? 'There is more cash than expected.' : 'There is less cash than expected.'}</p>
          <button class="outline" id="cash-reopen" style="margin-top:14px">Reopen this day</button>
        </section>` : `
        <section class="card page-panel">
          <div class="panel-head"><div><h3>Close the day</h3><p>Count every note and coin, then enter the total.</p></div></div>
          <label class="field" for="cash-counted">Cash counted in the drawer (₱)</label>
          <input class="login-input" id="cash-counted" type="number" min="0" step="0.01" placeholder="0.00">
          <div class="cash-variance" id="cash-variance">Enter the counted amount to see the difference.</div>
          <label class="field" for="cash-notes" style="margin-top:14px">Notes <em>(optional)</em></label>
          <input class="login-input" id="cash-notes" maxlength="200" placeholder="e.g. short ₱20, till was light this morning">
          <button class="login-submit" id="cash-close" style="margin-top:18px;width:auto;padding:0 20px;height:42px">Close day</button>
          <p class="sub">Once closed, the day is locked. You can reopen it with a reason if you make a mistake.</p>
        </section>`}
      <section class="card page-panel"><div class="panel-head"><div><h3>What made up today's cash</h3><p>Only cash movements are counted here — card and e-wallet payments are separate.</p></div></div>
        <div class="wf-row"><span>Membership payments (cash)</span><strong>${peso(perId(s.cash_in))}</strong></div>
        <div class="wf-row"><span>Non-cash takings (excluded)</span><strong>${peso(perId(s.non_cash))}</strong></div></section>`;

    const dateInput = ownerContent.querySelector('#cash-date');
    if (!dateInput || !body.isConnected) return;
    dateInput.onchange = () => loadCash();
    if (!closed) {
      const counted = ownerContent.querySelector('#cash-counted');
      const variance = ownerContent.querySelector('#cash-variance');
      const expected = perId(s.expected_cash);
      counted.oninput = () => {
        if (counted.value === '') { variance.textContent = 'Enter the counted amount to see the difference.'; variance.className = 'cash-variance'; return; }
        const diff = Number(counted.value) - expected;
        variance.className = 'cash-variance ' + (diff === 0 && expected >= 0 ? 'ok' : 'off');
        if (expected < 0) {
          // More went out of the drawer than came in: the float wasn't entered, so there is
          // nothing meaningful to compare against yet. Say that instead of "over by".
          variance.textContent = `You have paid out ${peso(Math.abs(expected))} more than came in. Enter the cash the drawer started with above, then count again.`;
          return;
        }
        variance.textContent = diff === 0
          ? `✓ Matches exactly — ${peso(expected)}`
          : `${diff > 0 ? 'Over' : 'Short'} by ${peso(Math.abs(diff))} (expected ${peso(expected)})`;
      };
      ownerContent.querySelector('#cash-save-float').onclick = async () => {
        try {
          await call('set_opening_float', { p_date: date, p_float: Number(ownerContent.querySelector('#cash-float').value || 0) });
          toastLive('Opening float saved'); loadCash();
        } catch (error) { toastLive(friendly(error)); }
      };
      ownerContent.querySelector('#cash-close').onclick = async () => {
        const countedField = ownerContent.querySelector('#cash-counted');
        if (!countedField) return;                 // tab changed under us
        const value = countedField.value;
        if (value === '') return toastLive('Enter the amount you counted.');
        const confirmed = await confirmDialog({
          title: 'Close this day?',
          body: `Counted <b>${peso(Number(value))}</b> against an expected <b>${peso(expected)}</b>.<br><br>Closing locks this day. You can reopen it later with a reason.`,
          confirm: 'Close day'
        });
        if (!confirmed) return;
        try {
          const notesField = ownerContent.querySelector('#cash-notes');   // re-query: the dialog await may have outlived the screen
          const row = await call('close_cash_day', { p_date: date, p_counted: Number(value), p_notes: notesField ? notesField.value.trim() || null : null });
          toastLive(Number(row.variance) === 0 ? 'Day closed. Drawer matched.' : `Day closed with a ${Number(row.variance) > 0 ? 'surplus' : 'shortfall'} of ${peso(Math.abs(Number(row.variance)))}`);
          loadCash();
        } catch (error) { toastLive(friendly(error)); }
      };
    } else {
      ownerContent.querySelector('#cash-reopen').onclick = async () => {
        const reason = await askReason('Reopen this day', 'Why does this day need reopening?');
        if (!reason) return;
        try { await call('reopen_cash_day', { p_date: date, p_reason: reason }); toastLive('Day reopened'); loadCash(); }
        catch (error) { toastLive(friendly(error)); }
      };
    }
  }

  /* A small prompt that insists on a reason — used by every reversal. */
  function askReason(title, question) {
    return new Promise(resolve => {
      const box = document.createElement('dialog');
      box.className = 'renew-dialog';
      box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">REQUIRED</div><h2>${esc(title)}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
        <p class="sub" style="margin:14px 0">${esc(question)}</p>
        <input class="login-input" id="reason-input" maxlength="200" placeholder="Type the reason">
        <p class="login-note reason-note" role="status"></p>
        <div class="renew-actions"><button type="button" class="outline reason-cancel">Cancel</button><button type="button" class="login-submit reason-go">Continue</button></div></div>`;
      document.body.append(box);
      const close = v => { box.close(); box.remove(); resolve(v); };
      const input = box.querySelector('#reason-input');
      box.querySelector('.renew-close').onclick = () => close(null);
      box.querySelector('.reason-cancel').onclick = () => close(null);
      box.querySelector('.reason-go').onclick = () => {
        const value = input.value.trim();
        if (value.length < 3) { box.querySelector('.reason-note').textContent = 'Please give a real reason (3+ characters).'; return; }
        close(value);
      };
      input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); box.querySelector('.reason-go').click(); } };
      box.addEventListener('cancel', e => { e.preventDefault(); close(null); });
      box.showModal();
      input.focus();
    });
  }

  /* ---- 80mm thermal receipt, openable and printable -------------------- */
  function printReceipt({ title, orNo, lines, total, method, cash, change, tax, footer, customer, date }) {
    const settings = live.settings || {};
    const gymName = settings.gym_name || 'HILL FITNESS GYM';
    const rows = lines.map(l => `<tr><td>${esc(l.label)}</td><td class="r">${peso(l.amount)}</td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(orNo || title)}</title>
<style>
 @page{size:80mm auto;margin:4mm}
 body{font:12px/1.45 "Courier New",monospace;color:#000;width:72mm;margin:6mm auto;padding:0 2mm}
 h1{font-size:15px;text-align:center;margin:0 0 2px;letter-spacing:.5px}
 .c{text-align:center}.muted{color:#444}
 hr{border:0;border-top:1px dashed #000;margin:7px 0}
 table{width:100%;border-collapse:collapse}
 td{padding:1px 0;vertical-align:top}
 .r{text-align:right;white-space:nowrap}
 .big{font-size:15px;font-weight:700}
 .tax{font-size:11px}
 @media print{body{width:auto}}
</style></head><body>
<h1>${esc(gymName.toUpperCase())}</h1>
${settings.business_address ? `<div class="c muted">${esc(settings.business_address)}</div>` : ''}
${settings.tin ? `<div class="c muted">TIN: ${esc(settings.tin)}</div>` : ''}
<div class="c muted">${settings.vat_registered ? 'VAT REGISTERED' : 'NON-VAT REGISTERED'}</div>
<hr>
<div class="muted">${esc(title)}</div>
<div>${orNo ? 'OR No: <b>' + esc(orNo) + '</b>' : ''}</div>
<div>${esc(date || phDateTime(new Date().toISOString()))}</div>
${customer ? `<div>Customer: ${esc(customer)}</div>` : ''}
<hr>
<table>${rows}</table>
<hr>
<table>
<tr><td class="big">TOTAL</td><td class="r big">${peso(total)}</td></tr>
${tax && Number(tax.vat) > 0 ? `<tr class="tax"><td>VAT included</td><td class="r">${peso(tax.vat)}</td></tr><tr class="tax"><td>Net of VAT</td><td class="r">${peso(tax.net)}</td></tr>` : ''}
<tr><td>Paid by</td><td class="r">${esc(method || 'Cash')}</td></tr>
${cash !== undefined && cash !== null ? `<tr><td>Cash</td><td class="r">${peso(cash)}</td></tr>` : ''}
${change !== undefined && change !== null ? `<tr><td>Change</td><td class="r">${peso(change)}</td></tr>` : ''}
</table>
<hr>
<div class="c muted">${esc(footer || 'Thank you. Train hard, recover harder.')}</div>
<div class="c muted" style="margin-top:4px">This document is not valid without the gym's stamp.</div>
</body></html>`;
    const win = window.open('', '_blank');
    if (!win) { toastLive('Allow pop-ups to print the receipt.'); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => { try { win.print(); } catch (error) { /* user can print manually */ } }, 350);
  }

  /* ---- Activity log browser -------------------------------------------- */
  function renderOwnerActivity() {
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">EVERY ACTION, ON THE RECORD</div><h2>Activity log</h2><p>Who did what, and when. Nothing here can be edited or erased.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <section class="card page-panel">
        <div class="panel-head"><div><h3>Search the log</h3><p>Filter by text, action type or date.</p></div><button class="outline" id="log-export">Export CSV ↓</button></div>
        <div class="log-filters">
          <input class="login-input" id="log-q" placeholder="Search who or what…">
          <select class="login-input" id="log-kind"><option value="">All action types</option>${(live.activityKinds || []).map(k => `<option value="${esc(k)}">${esc(k.replace(/_/g, ' '))}</option>`).join('')}</select>
          <input class="login-input" id="log-from" type="date">
          <input class="login-input" id="log-to" type="date">
          <button class="outline" id="log-run">Search</button>
        </div>
        <div id="log-results"><p class="sub">Loading…</p></div>
      </section>`;
    const run = async () => {
      const box = ownerContent.querySelector('#log-results');
      box.innerHTML = '<p class="sub">Searching…</p>';
      try {
        const rows = await call('search_activity', {
          p_query: ownerContent.querySelector('#log-q').value.trim() || null,
          p_kind: ownerContent.querySelector('#log-kind').value || null,
          p_from: ownerContent.querySelector('#log-from').value || null,
          p_to: ownerContent.querySelector('#log-to').value || null,
          p_limit: 200
        });
        box.innerHTML = rows.length ? `<div class="log-list">${rows.map(r => `<div class="log-row"><span class="log-kind">${esc(String(r.kind||'').replace(/_/g,' '))}</span><div><strong>${esc(r.summary)}</strong><small>${esc(r.actor_name || 'Gym')} · ${esc(phDateTime(r.created_at))}</small></div></div>`).join('')}</div>` : '<p class="sub">No entries match that search.</p>';
        const exportBtn = ownerContent.querySelector('#log-export');
        if (exportBtn) exportBtn.onclick = () => downloadCsv('gimmda-activity.csv', [['When','Type','Who','What'], ...rows.map(r => [phDateTime(r.created_at), r.kind, r.actor_name||'', r.summary])]);
      } catch (error) { box.innerHTML = `<p class="sub">${esc(friendly(error))}</p>`; }
    };
    ownerContent.querySelector('#log-run').onclick = run;
    ownerContent.querySelector('#log-q').onkeydown = e => { if (e.key === 'Enter') run(); };
    run();
  }

  /* ---- Broadcast: one message to many members --------------------------- */
  function renderOwnerBroadcast() {
    ownerContent.innerHTML = `
      <div class="report-header"><div><div class="eyebrow" style="color:#8ba284">TALK TO YOUR MEMBERS</div><h2>Announcements</h2><p>Send a notice that appears in each member's portal.</p></div><span class="report-demo"><span class="dot"></span> LIVE DATA</span></div>
      <div class="owner-members-layout"><section class="card owner-directory">
        <div class="panel-head"><div><div class="staff-kicker">NEW ANNOUNCEMENT</div><h3>Write a message</h3><p>Delivered to the member portal instantly.</p></div></div>
        <label class="field" for="bc-title">Title</label><input class="login-input" id="bc-title" maxlength="90" placeholder="e.g. Holiday schedule">
        <label class="field" for="bc-body">Message</label><textarea class="login-input" id="bc-body" rows="5" maxlength="800" placeholder="The gym will close early on Dec 24…"></textarea>
        <label class="field" for="bc-audience">Send to</label>
        <select class="login-input" id="bc-audience">
          <option value="all">All members</option>
          <option value="active">Active members only</option>
          <option value="expiring">Expiring within 7 days</option>
          <option value="expired">Expired members</option>
        </select>
        <div class="bc-preview" id="bc-preview"></div>
        <button class="login-submit" id="bc-send" style="margin-top:16px">Send announcement ↗</button>
        <p class="sub">Email and SMS delivery need a sender service, which isn't set up yet. Members see this the next time they open the portal.</p>
      </section>
      <aside class="card owner-member-detail"><div class="staff-kicker">SENT SO FAR</div><h3>Past announcements</h3>
        <div id="bc-history">${(live.broadcasts || []).length ? live.broadcasts.map(b => `<div class="profile-history"><div><b>${esc(b.title)}</b><small>${esc(b.sent_by_name || 'Owner')} · ${esc(phDateTime(b.created_at))} · ${b.recipients} members</small></div></div>`).join('') : '<p class="sub">Nothing sent yet.</p>'}</div>
      </aside></div>`;
    const audienceCount = () => {
      const audiences = { all: live.members.filter(m => !m.archived_at).length,
        active: live.members.filter(m => m.effective_status === 'Active').length,
        expiring: live.members.filter(m => m.expiring_soon).length,
        expired: live.members.filter(m => m.expired).length };
      return audiences[ownerContent.querySelector('#bc-audience').value] || 0;
    };
    const paint = () => {
      ownerContent.querySelector('#bc-preview').textContent = `This will reach ${audienceCount()} member${audienceCount() === 1 ? '' : 's'}.`;
    };
    ownerContent.querySelector('#bc-audience').onchange = paint;
    paint();
    ownerContent.querySelector('#bc-send').onclick = async () => {
      const title = ownerContent.querySelector('#bc-title').value.trim();
      const body = ownerContent.querySelector('#bc-body').value.trim();
      if (!title) return toastLive('Give the announcement a title.');
      if (!body) return toastLive('Write the message.');
      if (audienceCount() === 0) return toastLive('Nobody is in that audience right now.');
      const go = await confirmDialog({ title: 'Send this announcement?', body: `To <b>${audienceCount()}</b> members.<br><br><b>${esc(title)}</b><br>${esc(body)}`, confirm: 'Send' });
      if (!go) return;
      try {
        const sent = await call('send_broadcast', { p_title: title, p_body: body, p_audience: ownerContent.querySelector('#bc-audience').value });
        toastLive(`Announcement sent to ${sent.recipients} members.`);
        await refreshData(true);
        renderOwnerBroadcast();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  /* Dialogs --------------------------------------------------------------- */
  // Shown immediately after signing in with a temporary password. The account is
  // already authenticated but cannot reach any screen until it sets its own password.
  function showForcedPasswordChange() {
    loginScreen.hidden = true;
    ownerShell.hidden = true;
    staffShell.hidden = true;
    const panel = document.createElement('section');
    panel.className = 'login-screen';
    panel.innerHTML = `<div class="login-art"><div class="brand"><img class="brandmark" src="hill-logo-monochrome.png" alt=""><span class="product-brand-name">GIMMDA</span><span class="branding-divider" aria-hidden="true"></span><span class="gym-brand-name">HILL FITNESS GYM</span></div><div class="login-art-copy"><div class="eyebrow">ONE QUICK STEP</div><h2>Choose your<br>own <em>password.</em></h2><p>Your owner issued a temporary password. Set a private one only you know — this happens once.</p></div></div>
      <div class="login-side"><form class="login-form" id="forced-form"><h1>Set a new password.</h1><p class="intro-text">At least 10 characters. Use something you don't use anywhere else.</p>
      <label class="field" for="new-pw">New password</label><input class="login-input" id="new-pw" type="password" minlength="10" autocomplete="new-password" required>
      <label class="field" for="new-pw2">Repeat new password</label><input class="login-input" id="new-pw2" type="password" minlength="10" autocomplete="new-password" required>
      <div style="height:22px"></div><button class="login-submit" type="submit">Save password &amp; continue &nbsp; ↗</button>
      <p class="login-note forced-note" role="status"></p>
      <button type="button" class="outline forced-cancel" style="margin-top:12px;width:100%">Sign out instead</button></form></div>`;
    document.body.prepend(panel);
    const note = panel.querySelector('.forced-note');
    panel.querySelector('.forced-cancel').onclick = async () => {
      await sb.auth.signOut();
      panel.remove();
      loginScreen.hidden = false;
      emailInput.focus();
    };
    panel.querySelector('#forced-form').onsubmit = async event => {
      event.preventDefault();
      const first = panel.querySelector('#new-pw').value;
      const second = panel.querySelector('#new-pw2').value;
      if (first.length < 10) { note.textContent = 'Use at least 10 characters.'; return; }
      if (first !== second) { note.textContent = 'The two passwords do not match.'; return; }
      const button = panel.querySelector('.login-submit');
      button.disabled = true;
      note.textContent = 'Saving…';
      try {
        await ui.call('change_own_password', { p_new_password: first });
        const { data } = await sb.auth.getSession();
        panel.remove();
        await startSession(data.session);
      } catch (error) {
        button.disabled = false;
        note.textContent = friendly(error);
      }
    };
  }

  // Owner issues a temporary password for a team account. Email delivery is not
  // configured, so the owner reads this out and hands it over in person.
  function randomTempPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 14; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
  }

  function resetTeamPassword(account) {
    const temp = randomTempPassword();
    const box = dialog({
      title: 'Reset password',
      body: `<p>Issue a temporary password for <b>${esc(account.full_name || account.email)}</b> (${esc(account.email || '')}).</p>
        <p style="margin-top:10px">They sign in with it once and are then forced to choose their own. Any session they have open is signed out.</p>
        <label class="field" style="margin-top:16px">Temporary password</label>
        <input class="login-input" id="temp-pw" value="${esc(temp)}" readonly style="font-family:monospace;letter-spacing:.5px">
        <p class="sub" style="margin-top:8px">Copy this now — it will not be shown again.</p>`,
      action: 'Issue password',
      cancel: 'Cancel',
      onAction: async () => {
        try {
          await ui.call('owner_reset_password', { p_user: account.id, p_temp_password: temp });
          toastLive(`Temporary password issued for ${account.full_name || account.email}.`);
          await refreshData(true);
          renderOwnerTeam();
        } catch (error) { toastLive(friendly(error)); }
      },
    });
    setTimeout(() => {
      const field = box.querySelector('#temp-pw');
      if (field) { field.select(); document.execCommand?.('copy'); }
    }, 120);
  }

  function dialog({ title, body, action = 'OK', cancel = null, onAction, onCancel }) {
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<div class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">GIMMDA | HILL FITNESS GYM</div><h2>${esc(title)}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div><div class="dialog-message" style="color:#55695a;font-size:13px;line-height:1.8;margin:16px 0">${body}</div><div class="renew-actions">${cancel ? `<button type="button" class="outline act-cancel">${esc(cancel)}</button>` : ''}<button type="button" class="login-submit act-go">${esc(action)}</button></div></div>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('.act-go').onclick = () => { close(); onAction?.(); };
    const cancelButton = box.querySelector('.act-cancel');
    if (cancelButton) cancelButton.onclick = () => { close(); onCancel?.(); };
    box.addEventListener('cancel', event => { event.preventDefault(); close(); });
    box.showModal();
    return box;
  }

  function confirmDialog({ title, body, confirm = 'Confirm', cancel = 'Cancel' }) {
    return new Promise(resolve => {
      dialog({ title, body, action: confirm, cancel, onAction: () => resolve(true), onCancel: () => resolve(false) });
      const last = document.body.lastElementChild;
      if (last) last.addEventListener('close', () => resolve(false), { once: true });
    });
  }

  function promptDialog({ title, body, label, value = '', type = 'text' }) {
    return new Promise(resolve => {
      const box = document.createElement('dialog');
      box.className = 'renew-dialog';
      box.innerHTML = `<form class="renew-inner"><div class="renew-header"><div><div class="eyebrow" style="color:#87a278">GIMMDA | HILL FITNESS GYM</div><h2>${esc(title)}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div><p class="dialog-message" style="color:#55695a;font-size:13px;line-height:1.8;margin:16px 0">${body}</p><label class="field">${esc(label)}</label><input class="login-input prompt-value" type="${type}" value="${esc(value)}" required><div class="renew-actions"><button type="button" class="outline prompt-cancel">Cancel</button><button class="login-submit" type="submit">Save</button></div></form>`;
      document.body.append(box);
      const close = result => { box.close(); box.remove(); resolve(result); };
      box.querySelector('.renew-close').onclick = () => close(null);
      box.querySelector('.prompt-cancel').onclick = () => close(null);
      box.addEventListener('cancel', event => { event.preventDefault(); close(null); });
      box.querySelector('form').onsubmit = event => { event.preventDefault(); close(box.querySelector('.prompt-value').value.trim() || null); };
      box.showModal();
      box.querySelector('.prompt-value').focus();
    });
  }

  /* Boot ------------------------------------------------------------------ */
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') showLogin();
  });

  (async function boot() {
    // The first-run Account shortcut opens a short sign-up window; otherwise sign-ups stay closed.
    sb.rpc('owner_exists').then(({ data: hasOwner }) => {
      if (hasOwner === false) return sb.rpc('first_run_close');
      return null;
    });
    loginButton.disabled = true;
    loginButton.textContent = 'Checking session…';
    const { data: hasOwner } = await sb.rpc('owner_exists');
    setupNeeded = hasOwner === false;
    setupLink.hidden = !setupNeeded;
    const { data } = await sb.auth.getSession();
    if (data.session) await startSession(data.session);
    else {
      busy(false);
      setNote(setupNeeded ? 'No owner account yet. Use “Create the owner account” below to start.' : 'Sign in with the account the gym set up for you.');
    }
  })();
  /* Test hook: lets the automated suite exercise the receipt printer directly. */
  window.GIMMDA_TEST = { printReceipt, askReason, signedPeso };

})();
