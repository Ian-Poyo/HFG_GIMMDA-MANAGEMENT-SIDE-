/* GIMMDA dashboard · authentication gate and live wiring
   Loads after the dashboard script; overrides sample handlers with Supabase-backed ones. */
(function () {
  const ui = window.GIMMDA;
  const { live, sb, dash, escHtml: esc, peso, phToday, phDateTime, fmtDay, chTime, initials, planLabel, friendly } = ui;

  /* The signed-in identity. The account name typed at sign-up ("Gym Owner") is a
     placeholder, so the dashboard's Staff-page profile name wins when it differs;
     otherwise fall back to the account name, then the email prefix. */
  function currentIdentity() {
    const user = (live.session && live.session.user) || null;
    const meta = (user && user.user_metadata) || {};
    const profile = live.profile || {};
    const email = (user && user.email) || profile.email || '';
    const fromEmail = email ? email.split('@')[0].replace(/[._-]+/g, ' ').trim() : '';
    const metaName = (meta.full_name || meta.name || '').trim();
    const profileName = (profile.full_name || '').trim();
    const generic = /^(gym owner|owner|admin|user|staff|member)$/i.test(metaName);
    const name = profileName || (generic ? '' : metaName) || fromEmail || '';
    const label = name || email || 'Account';
    const parts = label.split(/\s+/).filter(Boolean);
    const first = parts.length ? parts[0] : 'there';
    const last = parts.length > 1 ? parts[parts.length - 1] : first;
    const ini = parts.length > 1
      ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
      : (parts[0]?.[0] || '?').toUpperCase();
    return { first, last, ini, label, email };
  }

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
  // The "Show" control in the password box was present in the markup but never wired,
  // so it did nothing. Bind it here (login form only; other forms keep their own inputs).
  /* Minimalist rotating showcase on the sign-in screen (3s interval) */
  (() => {
    const art = loginScreen?.querySelector('.login-art');
    const copy = loginScreen?.querySelector('#login-slide-copy');
    const countEl = loginScreen?.querySelector('#login-slide-count');
    const dots = [...(loginScreen?.querySelectorAll('.login-dots button') || [])];
    if (!art || !copy || !dots.length) return;
    const slides = [
      {
        kicker: '01 · MEMBERSHIPS & ATTENDANCE',
        title: 'Every shift,<br>every member,<br><em>in sync.</em>',
        body: 'Track active passes, check-ins, and renewals in one calm workspace.'
      },
      {
        kicker: '02 · INVENTORY & COUNTER SALES',
        title: 'Stock levels,<br>daily sales,<br><em>on point.</em>',
        body: 'Restock products, log walk-ins, and keep the front desk moving fast.'
      },
      {
        kicker: '03 · FINANCE & FEEDBACK',
        title: 'Clear profit,<br>member voice,<br><em>one view.</em>',
        body: 'Review daily takings, expenses, and member messages without clutter.'
      },
      {
        kicker: '04 · BUILT FOR HILL FITNESS',
        title: 'Quiet clarity<br>for your gym<br><em>every day.</em>',
        body: 'Role-based access and live records shared cleanly across your team.'
      }
    ];
    let idx = 0;
    let timer = 0;
    const renderSlide = (nextIdx, animate = true) => {
      idx = (nextIdx + slides.length) % slides.length;
      const sl = slides[idx];
      art.setAttribute('data-slide', String(idx));
      art.querySelectorAll('.login-art-bg').forEach((bg, i) => bg.classList.toggle('is-active', i === idx));
      copy.innerHTML = `<div class="login-slide-kicker">${sl.kicker}</div><h2>${sl.title}</h2><p>${sl.body}</p>`;
      if (animate) {
        copy.classList.remove('is-changing');
        void copy.offsetWidth;
        copy.classList.add('is-changing');
      }
      if (countEl) countEl.textContent = `0${idx + 1} / 0${slides.length}`;
      dots.forEach((b, i) => {
        b.classList.remove('is-active');
        void b.offsetWidth;
        if (i === idx) b.classList.add('is-active');
      });
    };
    const start = () => {
      clearInterval(timer);
      timer = setInterval(() => {
        if (loginScreen.hidden) return;
        renderSlide(idx + 1, true);
      }, 3000);
    };
    dots.forEach(btn => btn.addEventListener('click', () => {
      renderSlide(Number(btn.dataset.slideTo || 0), true);
      start();
    }));
    start();
  })();

  /* Cloudflare Turnstile verification (Managed light theme) */
  const turnstileKey = (ui.TURNSTILE_SITE_KEY || '').trim();
  const isTurnstileTestKey = /^1x0+AA$/i.test(turnstileKey);
  let loginCaptchaToken = '';
  let loginWidgetId = null;

  function mountTurnstile(container, wrap, onToken, onWidgetId) {
    if (!turnstileKey || !container) return () => {};
    let poll = 0;
    let active = true;
    const showFallback = () => {
      if (!active || !container.isConnected) return;
      if (wrap) wrap.hidden = false;
      container.innerHTML = '<div style="width:100%;padding:10px 12px;border:1px solid #e2d5d5;border-radius:10px;background:#fdf8f8;color:#7a4444;font:500 11px/1.5 \'DM Sans\',sans-serif;display:flex;align-items:center;justify-content:space-between;gap:10px"><span>Cloudflare verification could not load. Check network or ad-blocker.</span><button type="button" class="outline ts-retry" style="flex-shrink:0;padding:6px 10px">Retry</button></div>';
      const retryBtn = container.querySelector('.ts-retry');
      if (retryBtn) retryBtn.onclick = () => { container.innerHTML = ''; startMount(); };
    };
    const renderNow = () => {
      if (!active || !window.turnstile || !container.isConnected) return false;
      try {
        container.innerHTML = '';
        if (wrap) wrap.hidden = false;
        const wid = window.turnstile.render(container, {
          sitekey: turnstileKey,
          theme: 'light',
          size: 'flexible',
          callback: token => onToken(token || ''),
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken('')
        });
        if (onWidgetId) onWidgetId(wid);
        return true;
      } catch (e) { return false; }
    };
    const startMount = () => {
      clearInterval(poll);
      if (renderNow()) return;
      let tries = 0;
      poll = setInterval(() => {
        if (!active || !container.isConnected) { clearInterval(poll); return; }
        tries++;
        if (renderNow()) { clearInterval(poll); return; }
        if (tries > 32) { clearInterval(poll); showFallback(); }
      }, 250);
    };
    startMount();
    return () => { active = false; clearInterval(poll); };
  }

  function resetLoginTurnstile() {
    loginCaptchaToken = '';
    if (window.turnstile && loginWidgetId !== null) {
      try { window.turnstile.reset(loginWidgetId); } catch (e) { /* ignore */ }
    }
  }

  mountTurnstile(
    document.querySelector('#login-turnstile'),
    document.querySelector('#login-turnstile-wrap'),
    token => { loginCaptchaToken = token; },
    wid => { loginWidgetId = wid; }
  );

  const showPasswordButton = document.querySelector('#show-password');
  if (showPasswordButton && passwordInput) {
    showPasswordButton.addEventListener('click', () => {
      const revealed = passwordInput.type === 'text';
      passwordInput.type = revealed ? 'password' : 'text';
      showPasswordButton.textContent = revealed ? 'Show' : 'Hide';
      showPasswordButton.setAttribute('aria-pressed', String(!revealed));
      passwordInput.focus();
    });
  }
  const ownerShell = document.querySelector('.shell:not(#staff-shell)');
  const staffShell = document.querySelector('#staff-shell');
  const ownerContent = ownerShell.querySelector('.content');
  const staffContent = document.querySelector('#staff-content');
  const signOutButton = document.querySelector('#signout');
  const staffSignOut = document.querySelector('#staff-signout');
  const profileButton = document.querySelector('#profile-button');
  const staffProfileButton = document.querySelector('#staff-profile-button');
  const closeAccountMenus = () => {
    if (signOutButton) signOutButton.hidden = true;
    if (staffSignOut) staffSignOut.hidden = true;
    profileButton?.setAttribute('aria-expanded', 'false');
    staffProfileButton?.setAttribute('aria-expanded', 'false');
  };
  const signOut = async () => {
    closeAccountMenus();
    await sb.auth.signOut();
    loginScreen.hidden = false;
    ownerShell.hidden = true;
    staffShell.hidden = true;
    live.ready = false;
    live.profile = null;
    currentRole = null;
    passwordInput.value = '';
    resetLoginTurnstile();
    busy(false);
    setNote('You have been signed out.');
  };
  signOutButton?.addEventListener('click', signOut);
  staffSignOut?.addEventListener('click', signOut);

  /* Account menu + toolbar controls (the sample app used to wire these) */
  profileButton?.addEventListener('click', event => {
    event.stopPropagation();
    if (!signOutButton) return;
    signOutButton.hidden = !signOutButton.hidden;
    profileButton.setAttribute('aria-expanded', String(!signOutButton.hidden));
  });
  staffProfileButton?.addEventListener('click', event => {
    event.stopPropagation();
    if (!staffSignOut) return;
    staffSignOut.hidden = !staffSignOut.hidden;
    staffProfileButton.setAttribute('aria-expanded', String(!staffSignOut.hidden));
  });
  document.addEventListener('click', event => {
    if (!event.target.closest?.('.topright')) closeAccountMenus();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAccountMenus();
  });
  const syncMotion = on => {
    document.querySelectorAll('.motion-control').forEach(item => {
      item.textContent = on ? '✳ Motion on' : '✳ Motion off';
      item.setAttribute('aria-pressed', String(on));
    });
    document.body.classList.toggle('motion-demo-enabled', on);
  };
  syncMotion(document.querySelector('.motion-control')?.getAttribute('aria-pressed') !== 'false');
  document.querySelectorAll('.motion-control').forEach(button => {
    button.addEventListener('click', () => {
      const next = button.getAttribute('aria-pressed') !== 'true';
      syncMotion(next);
      if (next && currentRole === 'owner') {
        const activeTab = ownerNav?.querySelector('button.active')?.textContent.trim() || 'Overview';
        bootUpDashboard(ownerShell);
        refreshOwner(activeTab, true);
      } else if (next && currentRole === 'staff') {
        bootUpDashboard(staffShell);
        refreshStaff();
      }
    });
  });
  document.querySelector('.topright .iconbtn[title="Settings"]')?.addEventListener('click', () => {
    const settings = [...ownerNav.querySelectorAll('button')].find(item => item.textContent.trim() === 'Settings');
    settings?.click();
  });
  document.querySelector('.topright .iconbtn[title="Notifications"]')?.addEventListener('click', () => {
    const pendingAppr = (live.approvals || []).filter(a => a.status === 'pending');
    const pendingPay = live.payments.filter(p => p.status === 'pending');
    const pendingReq = live.requests.filter(r => r.status === 'pending');
    const pendingTotal = pendingAppr.length + pendingPay.length + pendingReq.length;
    const pendingHtml = pendingTotal ? `<div style="background:#f5f9ef;border:1px solid #d9e9c8;border-radius:12px;padding:12px 14px;margin-bottom:14px">
      <b style="color:#1e3a24;display:block;margin-bottom:6px">${pendingTotal} pending approval${pendingTotal === 1 ? '' : 's'} waiting</b>
      ${pendingAppr.map(a => `<div style="font-size:12px;color:#35513b;margin-top:4px">• ${esc(a.target_label)} (${esc(a.requested_by_name || 'Staff')}: "${esc(a.reason)}")</div>`).join('')}
      ${pendingPay.map(p => `<div style="font-size:12px;color:#35513b;margin-top:4px">• ${esc(p.member_name || 'Member')} online payment (${peso(p.amount)})</div>`).join('')}
      ${pendingReq.map(() => `<div style="font-size:12px;color:#35513b;margin-top:4px">• Member profile change request</div>`).join('')}
    </div>` : '';
    const items = live.activity.slice(0, 8);
    const body = pendingHtml + (items.length ? items.map(a => `<strong>${esc(a.summary)}</strong><br><span style="color:#8b9a8d">${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</span>`).join('<hr style="border:0;border-top:1px solid #eef2ec;margin:11px 0">') : 'No activity recorded yet.');
    dialog({
      title: 'Notifications & approvals',
      body,
      action: pendingTotal ? 'Review approvals ↗' : 'Close',
      onAction: () => {
        if (!pendingTotal) return;
        const ovBtn = [...ownerNav.querySelectorAll('button')].find(b => b.textContent.trim() === 'Overview');
        ovBtn?.click();
        setTimeout(() => document.querySelector('#needs-review-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
      }
    });
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
      <div class="cf-turnstile-wrap" id="forgot-turnstile-wrap" hidden><div id="forgot-turnstile"></div></div>
      <p class="login-note forgot-note" role="status" style="text-align:left"></p>
      <div class="renew-actions"><button type="button" class="outline act-cancel">Cancel</button><button class="login-submit" type="submit">Send reset link</button></div>
      <p class="renew-hint">No email yet? Ask the owner to issue a temporary password from the Staff page.</p></form>`;
    document.body.append(box);
    let forgotToken = '';
    let forgotWidgetId = null;
    const stopForgotTs = mountTurnstile(
      box.querySelector('#forgot-turnstile'),
      box.querySelector('#forgot-turnstile-wrap'),
      token => { forgotToken = token; },
      wid => { forgotWidgetId = wid; }
    );
    const resetForgotTs = () => {
      forgotToken = '';
      if (window.turnstile && forgotWidgetId !== null) {
        try { window.turnstile.reset(forgotWidgetId); } catch (e) { /* ignore */ }
      }
    };
    const close = () => {
      stopForgotTs();
      if (window.turnstile && forgotWidgetId !== null) {
        try { window.turnstile.remove(forgotWidgetId); } catch (e) { /* ignore */ }
      }
      box.close();
      box.remove();
    };
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
        if (turnstileKey && !isTurnstileTestKey && !forgotToken) {
          button.disabled = false;
          note.style.color = '#a05a5a';
          note.textContent = 'Please complete the Cloudflare verification check above.';
          return;
        }
        const { error } = await sb.auth.resetPasswordForEmail(address, {
          redirectTo: window.location.origin + window.location.pathname,
          ...(!isTurnstileTestKey && forgotToken ? { captchaToken: forgotToken } : {})
        });
        if (error) {
          resetForgotTs();
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
        resetForgotTs();
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
      panel.innerHTML = `<div class="login-shell"><aside class="login-art"><div class="login-art-top"><span class="login-gym-tag">HILL FITNESS GYM</span><span class="login-ver">RECOVERY</span></div><div class="login-art-copy"><div class="eyebrow">ACCOUNT RECOVERY</div><h2>Back to<br>your <em>gym.</em></h2><p>Your reset link is valid. Choose a new password and you're straight back in.</p></div><div class="login-art-foot"><span>HILL FITNESS GYM</span><span>GIMMDA WORKSPACE</span></div></aside>
        <div class="login-side"><form class="login-form" id="recover-form"><h1>Set a new password.</h1><p class="intro-text">At least 10 characters.</p>
        <label class="field" for="rec-pw">New password</label><input class="login-input" id="rec-pw" type="password" minlength="10" autocomplete="new-password" required>
        <label class="field" for="rec-pw2">Repeat new password</label><input class="login-input" id="rec-pw2" type="password" minlength="10" autocomplete="new-password" required>
        <div style="height:22px"></div><button class="login-submit" type="submit">Save password &amp; sign in &nbsp; ↗</button>
        <p class="login-note rec-note" role="status"></p></form></div></div>`;
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
        return setNote(`Too many failed attempts. Try again in ${throttle.retry_after_minutes} minutes.`, 'error');
      }
    } catch (failure) { /* never block a sign-in because the check itself failed */ }
    if (turnstileKey && !isTurnstileTestKey && !loginCaptchaToken) {
      busy(false);
      return setNote('Please complete the Cloudflare verification check above.', 'error');
    }
    const signInOpts = (!isTurnstileTestKey && loginCaptchaToken) ? { captchaToken: loginCaptchaToken } : undefined;
    const { data, error } = await sb.auth.signInWithPassword({
      email,
      password,
      ...(signInOpts ? { options: signInOpts } : {})
    });
    try { await sb.rpc('record_login_attempt', { p_email: email, p_succeeded: !error }); } catch (failure) { /* logging a failed attempt must never block sign-in */ }
    if (error) {
      resetLoginTurnstile();
      const message = /invalid login credentials/i.test(error.message)
        ? 'Unable to sign in. Incorrect email or password.'
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
      resetLoginTurnstile();
      busy(false);
      setNote('Unable to sign in. You cannot access this account right now.', 'error');
      return;
    }
    if (!profile.is_active) {
      await sb.auth.signOut();
      resetLoginTurnstile();
      busy(false);
      setNote('Unable to sign in. This account is inactive.', 'error');
      return;
    }
    if (profile.role === 'member') {
      try {
        const { error: memberErr } = await sb.rpc('member_portal_data');
        if (memberErr) throw memberErr;
        window.location.replace('/member/');
        return;
      } catch (memberLoadError) {
        await sb.auth.signOut();
        resetLoginTurnstile();
        busy(false);
        setNote('Unable to sign in. You cannot access this account right now.', 'error');
        return;
      }
    }
    if (profile.role !== 'owner' && profile.role !== 'staff') {
      await sb.auth.signOut();
      resetLoginTurnstile();
      busy(false);
      setNote('Unable to sign in. Access denied.', 'error');
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
    resetLoginTurnstile();
    busy(false);
    emailInput.focus();
  }

  function enter(role) {
    currentRole = role;
    loginScreen.hidden = true;
    if (role === 'staff') {
      ownerShell.hidden = true;
      staffShell.hidden = false;
      bootUpDashboard(staffShell);
      refreshStaff();
      window.scrollTo(0, 0);
      return;
    }
    ownerShell.hidden = false;
    staffShell.hidden = true;
    const who = currentIdentity();
    ownerShell.querySelector('.intro h1').innerHTML = `Good day, <em id="owner-greeting-name">${esc(who.last)}.</em>`;
    ownerShell.querySelector('.avatar').textContent = who.ini;
    ownerShell.querySelector('.avatar').title = who.label;
    if (live.settings?.gym_name) {
      const gymBrand = ownerShell.querySelector('.gym-brand-name');
      if (gymBrand) gymBrand.textContent = live.settings.gym_name.toUpperCase();
    }
    bootUpDashboard(ownerShell);
    refreshOwner('Overview', true);
    window.scrollTo(0, 0);
  }

  /* Live data badge */
  function markLive(root) {
    if (!root) return;
    root.querySelectorAll('.updated').forEach(el => { el.innerHTML = '<span class="dot"></span> Live gym data · Synced ' + new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }); });
  }

  /* Clean up the old timer before replacing it, otherwise a leftover 420ms apply()
     reads during the next slide transition and snaps the highlight back. */
  let navSettleTimer = 0;
  function revealNavigation(nav) {
    const active = nav.querySelector('button.active');
    if (!active) return;
    clearTimeout(navSettleTimer);
    if (nav.scrollWidth > nav.clientWidth + 2) {
      active.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    const apply = () => {
      const navBox = nav.getBoundingClientRect();
      const box = active.getBoundingClientRect();
      nav.style.setProperty('--tab-left', box.left - navBox.left + nav.scrollLeft + 'px');
      nav.style.setProperty('--tab-width', box.width + 'px');
    };
    apply();
    requestAnimationFrame(apply);
    navSettleTimer = setTimeout(apply, 420);
  }
  window.addEventListener('resize', () => {
    if (ownerNav && !ownerShell.hidden) revealNavigation(ownerNav);
    if (staffNav && !staffShell.hidden) revealNavigation(staffNav);
  });

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
    const buttons = [...nav.querySelectorAll('button')];
    const prevIdx = buttons.findIndex(b => b.classList.contains('active'));
    const nextIdx = buttons.indexOf(button);
    const dir = (prevIdx >= 0 && nextIdx >= 0) ? (nextIdx >= prevIdx ? 1 : -1) : 0;
    const contentEl = nav.closest('.shell')?.querySelector('.content');
    if (contentEl) {
      contentEl.style.setProperty('--slide-dir', String(dir));
      contentEl.dataset.slideDir = dir < 0 ? 'back' : 'forward';
    }
    buttons.forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    revealNavigation(nav);
  }

  const PERIOD_LABELS = { today: 'Today', week: 'This week', month: 'This month', last_month: 'Last month', year: 'This year', last_year: 'Last year' };
  const periodText = (lower = false) => {
    if (live.period === 'custom' && live.customFrom && live.customTo) {
      return `${fmtDay(live.customFrom)} – ${fmtDay(live.customTo)}`;
    }
    const t = PERIOD_LABELS[live.period] || 'This month';
    return lower ? t.toLowerCase() : t;
  };
  const currentPeriodRange = () => (ui.periodRange ? ui.periodRange(live.period) : (live.period === 'week' ? ui.weekRange() : ui.monthRange()));

  function syncPeriodControl(view) {
    if (periodWrap) periodWrap.style.display = ['Overview', 'Reports', 'Finance'].includes(view) ? '' : 'none';
    if (periodMenu) {
      periodMenu.hidden = true;
      periodMenu.querySelectorAll('button[data-period]').forEach(btn => {
        const mark = btn.querySelector('span');
        if (mark) mark.textContent = btn.dataset.period === live.period ? '✓' : '';
      });
    }
    if (periodButton) {
      periodButton.textContent = `${periodText()} ⌄`;
      periodButton.setAttribute('aria-expanded', 'false');
    }
  }

  function motionActive() {
    return document.body.classList.contains('motion-demo-enabled');
  }

  function triggerSweep(root) {
    if (!root || !motionActive()) return;
    root.querySelectorAll('.dashboard-reveal-sweep').forEach(el => el.remove());
    const sweep = document.createElement('div');
    sweep.className = 'dashboard-reveal-sweep';
    if (root.dataset?.slideDir === 'back') sweep.dataset.dir = 'back';
    sweep.setAttribute('aria-hidden', 'true');
    root.prepend(sweep);
    setTimeout(() => { if (sweep.isConnected) sweep.remove(); }, 800);
  }

  function animateNumbers(root) {
    if (!root || !motionActive()) return;
    const targets = root.querySelectorAll('.rp-hero-value strong, .rp-kpi strong, .rp-hero-split b, .ov-big strong, .ov-donut-num, .rp-export-figure strong');
    targets.forEach((el, idx) => {
      const raw = (el.dataset.targetText || el.textContent || '').trim();
      if (!raw) return;
      el.dataset.targetText = raw;
      const m = raw.match(/^([+\-−]?₱?)([0-9][0-9,]*(?:\.[0-9]+)?)(%?)$/);
      if (!m) return;
      const [, prefix, numStr, suffix] = m;
      const decimals = (numStr.split('.')[1] || '').length;
      const target = Number(numStr.replace(/,/g, ''));
      if (!Number.isFinite(target)) return;
      if (target === 0) {
        el.classList.remove('num-zero-pop');
        void el.offsetWidth;
        el.classList.add('num-zero-pop');
        return;
      }
      const duration = 640 + Math.min(idx * 30, 180);
      const start = performance.now();
      const format = v => {
        const fixed = v.toLocaleString('en-PH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
        return `${prefix}${fixed}${suffix}`;
      };
      const tick = now => {
        if (!el.isConnected || !motionActive()) { el.textContent = raw; return; }
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = p >= 1 ? raw : format(target * eased);
        if (p < 1) requestAnimationFrame(tick);
      };
      el.textContent = format(0);
      requestAnimationFrame(tick);
    });
  }

  function revealDashboard(root) {
    if (!root || !motionActive()) return;
    triggerSweep(root);
    animateNumbers(root);
  }
  window.revealDashboard = revealDashboard;

  let bootTimer = 0;
  function bootUpDashboard(shell) {
    if (!shell || !motionActive()) return;
    clearTimeout(bootTimer);
    shell.classList.remove('is-booting');
    shell.querySelectorAll('.boot-horizon').forEach(el => el.remove());
    const contentEl = shell.querySelector('.content');
    if (contentEl) {
      contentEl.style.setProperty('--slide-dir', '0');
      delete contentEl.dataset.slideDir;
    }
    const hero = shell.querySelector('.hero');
    if (hero) {
      const horizon = document.createElement('div');
      horizon.className = 'boot-horizon';
      horizon.setAttribute('aria-hidden', 'true');
      hero.appendChild(horizon);
    }
    void shell.offsetWidth;
    shell.querySelectorAll('.nav button').forEach((btn, i) => btn.style.setProperty('--nav-i', String(i)));
    shell.classList.add('is-booting');
    bootTimer = setTimeout(() => {
      shell.classList.remove('is-booting');
      shell.querySelectorAll('.boot-horizon').forEach(el => el.remove());
    }, 1050);
  }

  function fadeContent(root) {
    if (!motionActive()) return;
    triggerSweep(root);
  }

  /* Smooth SVG sparkline inside the two-tone bento hero */
  function buildSparklineSvg(rawPoints) {
    const pts = (rawPoints && rawPoints.length >= 2 ? rawPoints : [0, 0, 0, 0, 0, 0, 0]).map(v => Number(v) || 0);
    const w = 220, h = 58, padX = 6, padTop = 8, padBot = 10;
    const max = Math.max(...pts);
    const coords = pts.map((v, i) => {
      const x = padX + (i / (pts.length - 1)) * (w - padX * 2);
      const y = max > 0 ? padTop + (1 - v / max) * (h - padTop - padBot) : h - padBot;
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    let line = `M ${coords[0][0]} ${coords[0][1]}`;
    for (let i = 1; i < coords.length; i++) {
      const [x0, y0] = coords[i - 1];
      const [x1, y1] = coords[i];
      const cx = ((x0 + x1) / 2).toFixed(1);
      line += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    const area = `${line} L ${coords[coords.length - 1][0]} ${h} L ${coords[0][0]} ${h} Z`;
    const gid = 'sp' + Math.random().toString(36).slice(2, 8);
    const [lx, ly] = coords[coords.length - 1];
    return `<svg class="rp-spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#a6df5e" stop-opacity="0.22"/>
          <stop offset="100%" stop-color="#a6df5e" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <line x1="${padX}" y1="${h - padBot}" x2="${w - padX}" y2="${h - padBot}" class="rp-spark-base"/>
      <path d="${area}" fill="url(#${gid})" class="rp-spark-area"/>
      <path d="${line}" fill="none" class="rp-spark-line" pathLength="100"/>
      <circle cx="${lx}" cy="${ly}" r="3.5" class="rp-spark-dot"/>
    </svg>`;
  }

  /* Full-width animated SVG area trend graph (for Overview check-ins card) */
  function buildTrendGraphSvg(rawPoints, labels) {
    const pts = (rawPoints && rawPoints.length >= 2 ? rawPoints : [0, 0, 0, 0, 0, 0, 0]).map(v => Number(v) || 0);
    const w = 360, h = 96, padX = 10, padTop = 12, padBot = 14;
    const max = Math.max(...pts);
    const coords = pts.map((v, i) => {
      const x = padX + (i / (pts.length - 1)) * (w - padX * 2);
      const y = max > 0 ? padTop + (1 - v / max) * (h - padTop - padBot) : h - padBot - 2;
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    let line = `M ${coords[0][0]} ${coords[0][1]}`;
    for (let i = 1; i < coords.length; i++) {
      const [x0, y0] = coords[i - 1];
      const [x1, y1] = coords[i];
      const cx = ((x0 + x1) / 2).toFixed(1);
      line += ` C ${cx} ${y0}, ${cx} ${y1}, ${x1} ${y1}`;
    }
    const area = `${line} L ${coords[coords.length - 1][0]} ${h - padBot} L ${coords[0][0]} ${h - padBot} Z`;
    const gid = 'tg' + Math.random().toString(36).slice(2, 8);
    return `<div class="ov-trend">
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#8fce4e" stop-opacity="0.34"/>
            <stop offset="100%" stop-color="#8fce4e" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <line x1="0" y1="20" x2="${w}" y2="20" class="ov-trend-grid"/>
        <line x1="0" y1="50" x2="${w}" y2="50" class="ov-trend-grid"/>
        <line x1="0" y1="${h - padBot}" x2="${w}" y2="${h - padBot}" class="ov-trend-grid"/>
        <path d="${area}" fill="url(#${gid})" class="ov-trend-area"/>
        <path d="${line}" fill="none" class="ov-trend-line" pathLength="100"/>
        ${coords.map(([cx, cy], i) => `<circle cx="${cx}" cy="${cy}" r="3" class="ov-trend-dot" style="--pt-i:${i}"/>`).join('')}
      </svg>
      <div class="ov-trend-labels">${(labels || []).map(l => `<span>${esc(l)}</span>`).join('')}</div>
    </div>`;
  }

  /* Last N Manila days keys + short labels */
  function lastDays(n = 7) {
    const out = [];
    const todayIso = phToday();
    const [y, m, d] = todayIso.split('-').map(Number);
    for (let i = n - 1; i >= 0; i--) {
      const dt = new Date(Date.UTC(y, m - 1, d - i));
      const iso = dt.toISOString().slice(0, 10);
      const label = dt.toLocaleDateString('en-PH', { weekday: 'short', timeZone: 'UTC' });
      out.push({ iso, label });
    }
    return out;
  }

  /* Member avatar helper: renders photo_url if uploaded, else initials */
  function memberAvatar(member, cls = 'owner-member-avatar') {
    const label = member?.full_name || '?';
    return `<span class="${cls}">${member?.photo_url ? `<img src="${esc(member.photo_url)}" alt="">` : esc(initials(label))}</span>`;
  }

  /* Two-tone bento hero card shared across all tabs */
  function bentoHero({ label, valueHtml, sub, sparkLabel, sparkPeak, points, split, note = '' }) {
    return `<section class="rp-hero rp-bento">
      <div class="rp-hero-top">
        <div class="rp-hero-glow" aria-hidden="true"></div>
        <div class="rp-hero-main">
          <div class="rp-hero-label">${label}</div>
          <div class="report-card rp-hero-value">${valueHtml}</div>
          <div class="rp-hero-sub">${sub}</div>
        </div>
        <div class="rp-hero-spark">
          <div class="rp-spark-head"><span>${sparkLabel}</span><b>${sparkPeak}</b></div>
          ${buildSparklineSvg(points)}
        </div>
      </div>
      <div class="rp-hero-strip">
        <div class="rp-hero-split">${split.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('')}</div>
        ${note}
      </div>
    </section>`;
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
      refreshOwner(view, true);
      fadeContent(ownerContent);
    } else {
      if (staffButton.classList.contains('active')) return;
      selectTab(staffNav, staffButton);
      refreshStaff(staffButton.dataset.staffTab, true);
    }
  }, true);

  /* Period selector drives live reports and overview. */
  document.addEventListener('click', event => {
    if (currentRole !== 'owner') return;
    const item = event.target.closest('#period-menu button[data-period]');
    if (item) {
      event.stopImmediatePropagation();
      event.preventDefault();
      const chosen = item.dataset.period;
      const view = ownerNav.querySelector('button.active')?.textContent.trim() || 'Overview';
      if (chosen === 'custom') {
        if (periodMenu) periodMenu.hidden = true;
        periodButton?.setAttribute('aria-expanded', 'false');
        openCustomPeriodDialog(view);
        return;
      }
      live.period = chosen;
      syncPeriodControl(view);
      refreshData(true).then(() => { refreshOwner(view, true); });
      return;
    }
    if (event.target.closest('#period')) {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!periodMenu) return;
      periodMenu.hidden = !periodMenu.hidden;
      periodButton?.setAttribute('aria-expanded', String(!periodMenu.hidden));
      return;
    }
    if (periodMenu && !periodMenu.hidden && !event.target.closest('#period-wrap')) {
      periodMenu.hidden = true;
      periodButton?.setAttribute('aria-expanded', 'false');
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && periodMenu && !periodMenu.hidden) {
      periodMenu.hidden = true;
      periodButton?.setAttribute('aria-expanded', 'false');
      periodButton?.focus();
    }
  });

  function openCustomPeriodDialog(view) {
    const today = phToday();
    const cur = currentPeriodRange();
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.innerHTML = `<form class="renew-inner" id="custom-period-form">
      <div class="renew-header"><div><div class="eyebrow" style="color:#87a278">BACKTRACK DATES</div><h2>Custom date range</h2><p>Filter Overview, Reports, and Finance to any past dates.</p></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
      <div class="modal-two-col" style="margin-top:14px">
        <div><label class="field" for="cp-from">From</label><input id="cp-from" type="date" class="login-input" value="${esc(cur.from)}" max="${today}" required></div>
        <div><label class="field" for="cp-to">To</label><input id="cp-to" type="date" class="login-input" value="${esc(cur.to)}" max="${today}" required></div>
      </div>
      <p class="login-note" id="cp-note" role="status"></p>
      <div class="renew-actions"><button type="button" class="outline cp-cancel">Cancel</button><button type="submit" class="login-submit">Apply range ↗</button></div>
    </form>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('.cp-cancel').onclick = close;
    box.addEventListener('cancel', e => { e.preventDefault(); close(); });
    box.querySelector('#custom-period-form').onsubmit = e => {
      e.preventDefault();
      const from = box.querySelector('#cp-from').value;
      const to = box.querySelector('#cp-to').value;
      if (!from || !to || to < from) {
        const note = box.querySelector('#cp-note');
        note.textContent = 'End date must be on or after the start date.';
        note.style.color = '#a6453b';
        return;
      }
      live.customFrom = from;
      live.customTo = to;
      live.period = 'custom';
      close();
      syncPeriodControl(view);
      refreshData(true).then(() => refreshOwner(view, true));
    };
    box.showModal();
  }

  function refreshOwner(tab, animate = true) {
    paintGreeting();
    markLive(ownerContent);
    if (tab === 'Overview') renderOwnerOverview();
    else if (tab === 'Members') renderOwnerMembers();
    else if (tab === 'Staff') renderOwnerTeam();
    else if (tab === 'Reports') renderOwnerReports();
    else if (tab === 'Analytics') renderOwnerAnalytics();
    else if (tab === 'Settings') renderOwnerSettings();
    else if (tab === 'Inventory') renderOwnerInventory();
    else if (tab === 'Finance') renderOwnerFinance();
    else if (tab === 'Activity') renderOwnerActivity();
    else if (tab === 'Feedback' || tab === 'Feedback from members') renderOwnerFeedback();
    markLive(ownerContent);
    revealNavigation(ownerNav);
    if (animate) revealDashboard(ownerContent);
  }

  function summary() {
    const s = live.summary || {};
    const active = live.members.filter(m => m.effective_status === 'Active').length;
    const expiring = live.members.filter(m => m.expiring_soon).length;
    const expiringList = live.members.filter(m => m.expiring_soon).slice(0, 4);
    return { ...s, active, expiring, expiringList };
  }

  function paintGreeting() {
    const who = currentIdentity();
    const h1 = ownerShell?.querySelector('.intro h1');
    if (h1) h1.innerHTML = `Good day, <em id="owner-greeting-name">${esc(who.last)}.</em>`;
    const avatar = ownerShell?.querySelector('.avatar');
    if (avatar) {
      avatar.textContent = who.ini;
      avatar.title = who.label;
    }
    const gymBrand = ownerShell?.querySelector('.gym-brand-name');
    if (gymBrand && live.settings?.gym_name) {
      gymBrand.textContent = live.settings.gym_name.toUpperCase();
    }
  }

  function renderOwnerOverview() {
    const s = summary();
    const range = periodText(true);
    const revenue = Number(s.membership_revenue || 0) + Number(s.walkin_revenue || 0) + Number(s.product_revenue || 0);
    const recent = live.payments.slice(0, 5);
    const updates = live.activity.slice(0, 6);
    const pending = live.payments.filter(p => p.status === 'pending');
    const lowStock = live.inventory.filter(i => i.is_active && i.quantity <= i.threshold);
    const todayVisits = live.visits.filter(v => v.visit_date === phToday());
    const pct = s.active ? Math.min(100, (Number(s.checkins_today || 0) / Number(s.active)) * 100) : 0;
    const memberShare = s.total_members ? Math.round((s.active / s.total_members) * 100) : 0;
    const days7 = lastDays(7);
    const rev7 = days7.map(d =>
      live.payments.filter(p => p.status === 'approved' && !p.voided_at && String(p.paid_on).slice(0, 10) === d.iso).reduce((n, p) => n + Number(p.amount), 0)
      + live.walkins.filter(w => !w.voided_at && String(w.visited_on).slice(0, 10) === d.iso).reduce((n, w) => n + Number(w.amount), 0)
      + live.sales.filter(x => !x.voided_at && String(x.sold_on).slice(0, 10) === d.iso).reduce((n, x) => n + Number(x.total), 0)
    );
    const visits7 = days7.map(d => live.visits.filter(v => String(v.visit_date).slice(0, 10) === d.iso).length);
    const peak7 = Math.max(0, ...rev7);
    const review = [
      ...(live.approvals || []).filter(a => a.status === 'pending').map(a => ({
        icon: '!',
        title: `${a.target_label}`,
        sub: `${a.kind.replace(/_/g, ' ')} · requested by ${a.requested_by_name || 'Staff'} · "${a.reason}"`,
        action: `<button class="outline staff-approval-review" data-id="${a.id}">Review</button>`
      })),
      ...pending.map(p => ({ icon: '₱', title: `${p.member_name || 'Member'} · ${peso(p.amount)}`, sub: `${p.method} payment needs verification · ${p.receipt_no}`, action: `<button class="outline pay-approve" data-id="${p.id}">Verify</button>` })),
      ...live.requests.filter(r => r.status === 'pending').map(r => { const m = live.members.find(x => x.id === r.member_id); return { icon: '✎', title: m?.full_name || 'Member', sub: 'Profile change request', action: `<button class="outline request-approve" data-id="${r.id}">Review</button>` }; })
    ];
    const nameOf = p => p.member_name || (live.members.find(m => m.id === p.member_id) || {}).full_name || 'Member';
    const r = 52, circ = (2 * Math.PI * r).toFixed(2), arcOffset = ((1 - memberShare / 100) * Number(circ)).toFixed(2);

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">THE DAILY PULSE</div>
          <h2>Your gym overview</h2>
          <p>Live numbers from across your gym · ${range}.</p>
        </div>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: `REVENUE · ${range.toUpperCase()}`,
          valueHtml: `<strong>${peso(revenue)}</strong>`,
          sub: `Confirmed payments · ${pending.length} awaiting verification`,
          sparkLabel: '7-DAY TREND',
          sparkPeak: peak7 ? `Peak ${peso(peak7)}` : 'No activity yet',
          points: rev7,
          split: [
            ['MEMBERSHIPS', peso(s.membership_revenue)],
            ['WALK-INS', peso(s.walkin_revenue)],
            ['PRODUCTS', peso(s.product_revenue)]
          ]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>ACTIVE MEMBERS</small><strong>${s.active}</strong><em>${s.total_members || 0} total · ${s.deactivated_members || 0} deactivated</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>CHECK-INS TODAY</small><strong>${s.checkins_today || 0}</strong><em>${s.open_visits || 0} still inside</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>EXPIRING SOON</small><strong>${s.expiring || 0}</strong><em>${s.expired || 0} already expired</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>LOW STOCK</small><strong>${lowStock.length}</strong><em>products at or below threshold</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card rp-chart-card">
          <div class="panel-head"><div><div class="staff-kicker">MEMBERSHIP HEALTH</div><h3>Active members</h3><p>How many of your members are still current.</p></div><span class="rp-pill">${memberShare}% active</span></div>
          <div class="ov-donut-wrap">
            <div class="ov-donut-box">
              <svg class="ov-donut-svg" viewBox="0 0 132 132" aria-hidden="true">
                <circle cx="66" cy="66" r="${r}" class="ov-donut-track"/>
                <circle cx="66" cy="66" r="${r}" class="ov-donut-arc" style="--circ:${circ};--arc-end:${arcOffset}" stroke-dasharray="${circ}" stroke-dashoffset="${arcOffset}"/>
              </svg>
              <span class="ov-donut-num">${s.active}</span>
            </div>
            <div class="ov-donut-legend">
              <div><span><i class="rp-dot ov-dot-active"></i>Active</span><b>${s.active}</b></div>
              <div><span><i class="rp-dot ov-dot-expiring"></i>Expiring soon</span><b>${s.expiring || 0}</b></div>
              <div><span><i class="rp-dot ov-dot-off"></i>Expired / off</span><b>${(s.expired || 0) + (s.deactivated_members || 0)}</b></div>
            </div>
          </div>
          <div class="ov-bar"><span style="width:${memberShare}%"></span></div>
          <div class="rp-chart-foot"><span>${s.active} active</span><span>${s.total_members || 0} total members</span></div>
        </section>

        <section class="card rp-mix-card">
          <div class="panel-head"><div><div class="staff-kicker">TODAY AT THE GYM</div><h3>Check-ins</h3><p>7-day door traffic and today’s count.</p></div><span class="rp-pill">${s.open_visits || 0} inside</span></div>
          <div class="ov-big"><strong>${s.checkins_today || 0}</strong><span>members checked in today</span></div>
          ${buildTrendGraphSvg(visits7, days7.map(d => d.label))}
          <div class="ov-rows">
            <div><span>Check-in rate today</span><b>${pct.toFixed(1)}% (${new Set(todayVisits.map(v => v.member_id)).size} unique)</b></div>
            <div><span>Pending payments</span><b>${pending.length}</b></div>
            <div><span>Low stock products</span><b>${lowStock.length}</b></div>
          </div>
        </section>
      </div>

      <div class="rp-mid">
        <section class="card rp-new-card" id="needs-review-card">
          <div class="panel-head"><div><div class="staff-kicker">NEEDS YOU</div><h3>Needs your review</h3><p>Staff void/deletion requests, online payments, and profile changes.</p></div><span class="rp-pill">${review.length} waiting</span></div>
          ${review.length ? review.map(r => `<div class="activity"><div class="activity-icon">${r.icon}</div><div class="activity-text"><b>${esc(r.title)}</b><br>${esc(r.sub)}</div>${r.action}</div>`).join('') : '<p class="sub" style="padding:8px 0">Nothing waiting for approval. You are all caught up.</p>'}
        </section>

        <section class="card rp-new-card">
          <div class="panel-head"><div><div class="staff-kicker">LATEST ACTIVITY</div><h3>Recorded by your team</h3><p>The most recent actions across the gym.</p></div></div>
          ${updates.length ? updates.slice(0, 5).map(a => `<div class="activity"><div class="activity-icon">✳</div><div class="activity-text"><b>${esc(a.summary)}</b><br>${esc(a.actor_name || 'Gym')}</div><div class="activity-time">${esc(phDateTime(a.created_at))}</div></div>`).join('') : '<p class="sub" style="padding:8px 0">No activity yet.</p>'}
        </section>
      </div>

      <section class="card page-panel rp-table-card"><div class="panel-head"><div><div class="staff-kicker">RECENT PAYMENTS</div><h3>Latest transactions</h3><p>Newest first, across every source.</p></div></div>
        <div class="activity-list">${recent.length ? recent.map(p => `<div class="activity"><div class="activity-icon">₱</div><div class="activity-text"><b>${esc(nameOf(p))} · ${peso(p.amount)}</b><br>${esc(p.method)} · ${esc(p.receipt_no)} · ${esc(p.status)}</div><div class="activity-time">${esc(phDateTime(p.created_at))}</div></div>`).join('') : '<p class="sub" style="padding:10px 0">No payments recorded yet.</p>'}</div>
      </section>`;

    ownerContent.querySelectorAll('.staff-approval-review').forEach(button => button.onclick = () => reviewStaffApproval(button.dataset.id));
    ownerContent.querySelectorAll('.pay-approve').forEach(button => button.onclick = () => reviewPayment(button.dataset.id));
    ownerContent.querySelectorAll('.request-approve').forEach(button => button.onclick = () => reviewRequest(button.dataset.id));
  }

  function hasPendingApproval(kind, targetId) {
    return (live.approvals || []).some(a => a.status === 'pending' && a.kind === kind && a.target_id === targetId);
  }

  async function requestOwnerApproval(kind, targetId, label, onDone) {
    const kindLabels = {
      void_walkin: 'Void walk-in entry',
      void_sale: 'Void product sale',
      void_payment: 'Void payment',
      delete_member: 'Delete member record'
    };
    const reason = await askReason(kindLabels[kind] || 'Request owner approval', `Staff cannot delete or void records directly. Explain why "${label}" needs to be reversed or deleted — this goes straight to the owner for approval.`);
    if (!reason) return;
    try {
      await ui.call('request_staff_approval', { p_kind: kind, p_target_id: targetId, p_reason: reason });
      toastLive('Request sent to the owner for approval.');
      await refreshData(true);
      if (typeof onDone === 'function') onDone();
    } catch (error) { toastLive(friendly(error)); }
  }

  async function reviewStaffApproval(id) {
    const req = (live.approvals || []).find(a => a.id === id);
    if (!req) return;
    const kindLabels = {
      void_walkin: 'Void walk-in entry',
      void_sale: 'Void product sale (restores stock)',
      void_payment: 'Void membership payment',
      delete_member: 'Permanently delete member'
    };
    const decision = await new Promise(resolve => {
      const box = document.createElement('dialog');
      box.className = 'renew-dialog';
      box.innerHTML = `<div class="renew-inner">
        <div class="renew-header"><div><div class="eyebrow" style="color:#87a278">OWNER APPROVAL</div><h2>${esc(kindLabels[req.kind] || 'Staff approval request')}</h2></div><button type="button" class="renew-close" aria-label="Close">×</button></div>
        <p style="margin:14px 0;color:#415647;font-size:13px;line-height:1.7">
          <b>${esc(req.target_label)}</b><br>
          Requested by <b>${esc(req.requested_by_name || 'Staff')}</b> · ${esc(phDateTime(req.created_at))}<br><br>
          <b>Reason:</b> ${esc(req.reason)}
        </p>
        <p class="sub" style="margin:0 0 14px">Approving immediately applies this change and logs it to Activity. Closing this window leaves it pending.</p>
        <div class="renew-actions">
          <button type="button" class="outline" id="apv-reject">Reject</button>
          <button type="button" class="login-submit" id="apv-approve">Approve &amp; apply</button>
        </div>
      </div>`;
      document.body.append(box);
      const done = val => { box.close(); box.remove(); resolve(val); };
      box.querySelector('.renew-close').onclick = () => done(null);
      box.querySelector('#apv-reject').onclick = () => done(false);
      box.querySelector('#apv-approve').onclick = () => done(true);
      box.addEventListener('cancel', e => { e.preventDefault(); done(null); });
      box.showModal();
    });
    if (decision === null) return;
    try {
      await ui.call('review_staff_approval', { p_request_id: id, p_approve: !!decision, p_note: decision ? null : 'Declined by owner' });
      toastLive(decision ? 'Request approved and applied.' : 'Request rejected — record kept unchanged.');
      await refreshData(true);
      renderOwnerOverview();
    } catch (error) { toastLive(friendly(error)); }
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
    const all = live.members.length;
    const active = live.members.filter(m => m.effective_status === 'Active').length;
    const expiring = live.members.filter(m => m.expiring_soon).length;
    const deactivated = live.members.filter(m => m.effective_status === 'Deactivated').length;
    const share = all ? Math.round((active / all) * 100) : 0;
    const newest = live.members.filter(m => m.joined_on).slice(0, 5);

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">YOUR COMMUNITY</div>
          <h2>Member directory</h2>
          <p>Live member records from the shared gym database.</p>
        </div>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: 'TOTAL MEMBERS',
          valueHtml: `<strong>${all}</strong>`,
          sub: `${active} active · ${deactivated} deactivated`,
          sparkLabel: '7-DAY SIGN-UPS',
          sparkPeak: `${live.members.filter(m => lastDays(7).some(d => d.iso === String(m.joined_on).slice(0, 10))).length} this week`,
          points: lastDays(7).map(d => live.members.filter(m => String(m.joined_on).slice(0, 10) === d.iso).length),
          split: [['ACTIVE', active], ['EXPIRING SOON', expiring], ['DEACTIVATED', deactivated]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>ACTIVE MEMBERS</small><strong>${active}</strong><em>can check in today</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>EXPIRING SOON</small><strong>${expiring}</strong><em>within 7 days</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>DEACTIVATED</small><strong>${deactivated}</strong><em>expired or turned off</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">↗</span><div><small>ACTIVE SHARE</small><strong>${share}%</strong><em>of all members</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card owner-directory">
          <div class="panel-head"><div><div class="staff-kicker">MEMBERS AT A GLANCE</div><h3>All members</h3><p>Newest members first. Select a member for full details.</p></div><div class="owner-dir-actions"><button class="outline" id="owner-export">Export CSV ↓</button><button class="login-submit" id="owner-add" type="button" style="width:auto;height:34px;padding:0 15px;font-size:11px">+ Add member</button></div></div>
          <div class="owner-member-controls"><input class="login-input" id="owner-search" placeholder="Search name, ID, phone or email"><select class="login-input" id="owner-filter"><option value="all">All members</option><option value="active">Active</option><option value="deactivated">Deactivated</option><option value="expiring">Expiring soon</option></select></div>
          <div class="owner-member-list" id="owner-member-list"></div>
          <p id="owner-empty" class="sub" hidden>No members match your search.</p>
          <div class="owner-pager" id="owner-pager" hidden>
            <span class="owner-pager-count" id="owner-pager-count"></span>
            <div class="owner-pager-buttons">
              <button class="outline owner-page-prev" type="button" aria-label="Previous page">‹ Prev</button>
              <span class="owner-pager-pages" id="owner-pager-pages"></span>
              <button class="outline owner-page-next" type="button" aria-label="Next page">Next ›</button>
            </div>
          </div>
        </section>

        <div class="rp-side-stack">
          <section class="card rp-new-card">
            <div class="panel-head"><div><div class="staff-kicker">GROWTH</div><h3>Newest members</h3><p>Most recent sign-ups.</p></div></div>
            ${newest.length ? newest.map(m => `<div class="rp-new-row">${memberAvatar(m)}<div><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · joined ${esc(fmtDay(m.joined_on))}</small></div><span class="status-tag ${m.effective_status === 'Deactivated' ? 'status-deactivated' : ''}">${esc(m.effective_status)}</span></div>`).join('') : '<p class="sub">No members yet.</p>'}
          </section>
        </div>
      </div>`;
    const search = ownerContent.querySelector('#owner-search');
    const filter = ownerContent.querySelector('#owner-filter');
    const list = ownerContent.querySelector('#owner-member-list');
    const pager = ownerContent.querySelector('#owner-pager');
    const pagerCount = ownerContent.querySelector('#owner-pager-count');
    const pagerPages = ownerContent.querySelector('#owner-pager-pages');
    const prevBtn = ownerContent.querySelector('.owner-page-prev');
    const nextBtn = ownerContent.querySelector('.owner-page-next');
    const PAGE_SIZE = 8;
    let page = 1;

    /* Everything matching the search box and the status filter, in list order. */
    const matchingMembers = () => {
      const q = search.value.trim().toLowerCase();
      const mode = filter.value;
      return live.members.filter(member => {
        const text = [member.full_name, member.member_no, member.phone, member.email].join(' ').toLowerCase();
        return text.includes(q) && (
          mode === 'all' ||
          (mode === 'active' && member.effective_status === 'Active') ||
          (mode === 'deactivated' && member.effective_status === 'Deactivated') ||
          (mode === 'expiring' && member.expiring_soon)
        );
      });
    };

    const renderPage = () => {
      const matches = matchingMembers();
      const pageCount = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
      if (page > pageCount) page = pageCount;
      if (page < 1) page = 1;
      const slice = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      list.innerHTML = slice.length
        ? slice.map(memberRow).join('')
        : (live.members.length ? '' : '<p class="sub" style="padding:16px 0">No members yet. Staff can add the first member from the staff portal.</p>');
      ownerContent.querySelector('#owner-empty').hidden = !!matches.length;

      list.querySelectorAll('.owner-profile').forEach(button => { button.onclick = () => showOwnerMember(button.dataset.id); });

      pager.hidden = matches.length === 0;
      const from = matches.length ? (page - 1) * PAGE_SIZE + 1 : 0;
      const to = Math.min(page * PAGE_SIZE, matches.length);
      pagerCount.textContent = `Showing ${from}–${to} of ${matches.length} member${matches.length === 1 ? '' : 's'}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= pageCount;

      // numbered buttons, with gaps when there are many pages
      const buttons = [];
      const addPage = n => buttons.push(`<button type="button" class="owner-page-num${n === page ? ' is-current' : ''}" data-page="${n}" aria-current="${n === page ? 'page' : 'false'}">${n}</button>`);
      const gap = () => buttons.push('<span class="owner-pager-gap" aria-hidden="true">…</span>');
      if (pageCount <= 7) {
        for (let n = 1; n <= pageCount; n += 1) addPage(n);
      } else {
        addPage(1);
        if (page > 3) gap();
        for (let n = Math.max(2, page - 1); n <= Math.min(pageCount - 1, page + 1); n += 1) addPage(n);
        if (page < pageCount - 2) gap();
        addPage(pageCount);
      }
      pagerPages.innerHTML = buttons.join('');
      pagerPages.querySelectorAll('.owner-page-num').forEach(button => {
        button.onclick = () => { page = Number(button.dataset.page); renderPage(); };
      });
    };

    prevBtn.onclick = () => { page -= 1; renderPage(); };
    nextBtn.onclick = () => { page += 1; renderPage(); };
    search.oninput = () => { page = 1; renderPage(); };
    filter.onchange = () => { page = 1; renderPage(); };
    const ownerAddBtn = ownerContent.querySelector('#owner-add');
    if (ownerAddBtn) ownerAddBtn.onclick = () => addMemberLive(() => renderOwnerMembers());
    ownerContent.querySelector('#owner-export').onclick = exportMembers;
    renderPage();
  }

  function memberRow(m) {
    const tag = m.effective_status === 'Deactivated' ? 'status-deactivated' : m.expiring_soon ? 'status-expiring' : '';
    return `<div class="owner-member-row" data-id="${m.id}">${memberAvatar(m)}<div class="owner-member-info"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'Plan not set')}</small></div><div class="owner-member-expiry"><small>EXPIRES</small><strong>${esc(fmtDay(m.expires_on))}</strong></div><span class="status-tag ${tag}">${m.effective_status === 'Deactivated' && m.expired ? 'Expired' : m.effective_status}${m.expiring_soon ? ' · Soon' : ''}</span><button class="outline owner-profile" data-id="${m.id}">View ↗</button></div>`;
  }

  function openMemberProfileModal(id) {
    const member = live.members.find(m => m.id === id);
    if (!member) return;
    document.querySelector('#member-profile-dialog')?.remove();

    const isOwnerView = currentRole === 'owner';
    const payments = live.payments.filter(p => p.member_id === id).slice(0, 6);
    const visits = live.visits.filter(v => v.member_id === id).slice(0, 6);
    const statusClass = member.effective_status === 'Deactivated' ? 'status-deactivated' : member.expiring_soon ? 'status-expiring' : '';
    const statusLabel = member.effective_status === 'Deactivated' && member.expired ? 'Expired' : member.effective_status;
    const frozen = !!member.frozen_at;
    const archived = !!member.archived_at;

    const box = document.createElement('dialog');
    box.className = 'renew-dialog member-profile-dialog';
    box.id = 'member-profile-dialog';
    box.innerHTML = `
      <div class="mp-head">
        <img class="mp-head-watermark" src="green-emblem.png" alt="" aria-hidden="true">
        <div class="mp-head-top">
          <div class="mp-brand">
            <span class="mp-brand-badge"><img src="green-emblem.png" alt="GIMMDA"></span>
            <div>
              <div class="eyebrow">MEMBER PROFILE</div>
              <span class="mp-brand-sub">GIMMDA · HILL FITNESS GYM</span>
            </div>
          </div>
          <button type="button" class="mp-close" aria-label="Close">×</button>
        </div>
        <div class="mp-identity">
          <div class="mp-avatar" id="member-photo">${member.photo_url ? `<img src="${esc(member.photo_url)}" alt="">` : `<span>${esc(initials(member.full_name))}</span>`}</div>
          <div class="mp-id-info">
            <h2>${esc(member.full_name)}</h2>
            <p>${esc(member.member_no)} · Joined ${esc(fmtDay(member.joined_on))}</p>
            <div class="mp-photo-bar">
              <label class="mp-photo-btn photo-upload">${member.photo_url ? 'Change photo' : 'Upload photo'}<input type="file" id="photo-file" accept="image/jpeg,image/png,image/webp" hidden></label>
              ${member.photo_url ? '<button type="button" class="mp-photo-btn" id="photo-remove">Remove</button>' : ''}
            </div>
          </div>
          <span class="status-tag ${statusClass}">${esc(statusLabel)}</span>
        </div>
        <div class="mp-plan-strip">
          <div><small>PLAN</small><strong>${esc(member.plan_months ? planLabel(member.plan_months) : 'No plan')}</strong></div>
          <div><small>START</small><strong>${esc(fmtDay(member.starts_on))}</strong></div>
          <div><small>EXPIRY</small><strong>${esc(fmtDay(member.expires_on))}</strong></div>
          <div><small>REMINDERS</small><strong>${member.reminders ? 'On' : 'Off'}</strong></div>
        </div>
      </div>

      <div class="mp-body">
        <div class="mp-action-bar">
          <button type="button" class="login-submit renew-now">Record payment / renew ↗</button>
          <button type="button" class="outline status-toggle">${member.status === 'Active' ? 'Deactivate' : 'Reactivate'}</button>
          ${isOwnerView ? (
            frozen ? `<button type="button" class="outline" id="act-unfreeze">Resume membership</button>`
            : archived ? `<button type="button" class="outline" id="act-restore">Restore member</button>`
            : `<button type="button" class="outline" id="act-freeze">Freeze / hold</button><button type="button" class="outline" id="act-merge">Merge</button><button type="button" class="outline" id="act-archive">Archive</button>`
          ) : ''}
          ${isOwnerView
            ? '<button type="button" class="outline member-act-danger" id="act-delete">Delete member</button>'
            : (hasPendingApproval('delete_member', member.id)
              ? '<button type="button" class="outline member-act-danger staff-delete-member" id="act-delete" disabled>Deletion pending owner</button>'
              : '<button type="button" class="outline member-act-danger staff-delete-member" id="act-delete">Request deletion</button>')}
        </div>

        ${frozen ? `<div class="frozen-banner" style="margin:0">Frozen until <b>${esc(fmtDay(member.frozen_until))}</b> — expiry moved to ${esc(fmtDay(member.expires_on))}.<br><small>${esc(member.freeze_reason || '')}</small></div>` : ''}
        ${archived ? `<div class="frozen-banner" style="margin:0">Archived — ${esc(member.archive_reason || 'no reason recorded')}.<br><small>Their payments and visits are kept in the books.</small></div>` : ''}

        <div class="mp-card">
          <div class="mp-card-title">CONTACT &amp; DETAILS <span>Direct edit</span></div>
          <form id="${isOwnerView ? 'owner-edit-member' : 'staff-edit-member'}" class="profile-form">
            <div class="modal-two-col">
              <div><label class="field">Full name</label><input class="login-input oe-name p-name" value="${esc(member.full_name)}" required maxlength="100"></div>
              <div><label class="field">Mobile</label><input class="login-input oe-phone p-phone" value="${esc(member.phone || '')}" maxlength="30" placeholder="Optional"></div>
              <div><label class="field">Email</label><input class="login-input oe-email p-email" type="email" value="${esc(member.email || '')}" placeholder="Optional"></div>
              <div><label class="field">Emergency contact</label><input class="login-input oe-emergency p-emergency" value="${esc(member.emergency_contact || '')}" maxlength="100" placeholder="Optional"></div>
              <div class="modal-span-2"><label class="field">Address</label><input class="login-input oe-address p-address" value="${esc(member.address || '')}" maxlength="200" placeholder="Optional"></div>
            </div>
            <div class="mp-form-foot">
              <span class="sub" style="margin:0">Updates save directly to the gym record.</span>
              <button class="login-submit" type="submit">Save changes</button>
            </div>
          </form>
        </div>

        <div class="modal-two-col">
          <div class="mp-card">
            <div class="mp-card-title">RECENT PAYMENTS <span>${payments.length}</span></div>
            <div class="mp-history-list">${payments.length ? payments.map(p => `<div class="mp-history-item"><div><strong>${esc(p.receipt_no)}</strong><small>${esc(phDateTime(p.created_at))} · ${esc(p.method)} · ${esc(p.status)}</small></div><b>${peso(p.amount)}</b></div>`).join('') : '<p class="sub" style="margin:0">No payments recorded.</p>'}</div>
          </div>
          <div class="mp-card">
            <div class="mp-card-title">RECENT VISITS <span>${visits.length}</span></div>
            <div class="mp-history-list">${visits.length ? visits.map(v => `<div class="mp-history-item"><div><strong>${esc(phDateTime(v.checked_in_at))}</strong><small>${v.checked_out_at ? 'Out ' + esc(phDateTime(v.checked_out_at)) : 'Still inside'}</small></div></div>`).join('') : '<p class="sub" style="margin:0">No visits recorded.</p>'}</div>
          </div>
        </div>

        <div class="mp-card">
          <div class="mp-card-title">MEMBER PORTAL ACCESS &amp; PASSWORD <span>${member.auth_user_id ? 'Login active' : 'No login yet'}</span></div>
          ${member.auth_user_id
            ? `<p class="sub" style="margin:0 0 10px;line-height:1.6">This member can sign in to the Member Portal${member.email ? ` using <b>${esc(member.email)}</b>` : ''}. Set a new password below if they forgot theirs.</p>
               <form id="member-password-form">
                 <label class="field" for="mp-new-password">Change portal password</label>
                 <div class="mp-pw-grid">
                   <div class="input-box">
                     <input class="login-input" id="mp-new-password" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required>
                     <button type="button" class="password-toggle" id="mp-pw-toggle" aria-label="Show password">Show</button>
                   </div>
                   <button type="button" class="outline" id="mp-pw-gen">Generate</button>
                   <button type="submit" class="login-submit" id="mp-pw-save">Update password</button>
                 </div>
                 <p class="sub" style="margin:8px 0 0;font-size:10.5px">Minimum 8 characters. Takes effect immediately and signs out old sessions.</p>
               </form>`
            : isOwnerView
              ? `<p class="sub" style="margin:0 0 10px;line-height:1.7">This member cannot sign in yet. Create a login below or link an existing account.</p>
                 <div class="modal-two-col" style="align-items:end">
                   <div><label class="field">Account email</label><input class="login-input" id="login-email" type="email" placeholder="member@email.com" value="${esc(member.email || '')}"></div>
                   <div><button type="button" class="login-submit" id="create-login" style="height:40px">Create portal login</button></div>
                 </div>
                 <details style="margin-top:12px"><summary class="sub" style="cursor:pointer">Already have an account for them?</summary>
                   <div class="modal-two-col" style="align-items:end;margin-top:8px">
                     <div><label class="field">Account email</label><input class="login-input" id="link-email" type="email" placeholder="member@email.com"></div>
                     <div><button type="button" class="outline" id="link-account" style="height:40px;width:100%">Link existing account</button></div>
                   </div>
                 </details>`
              : '<p class="sub" style="margin:0;line-height:1.6">This member does not have a portal login linked yet. Ask the owner to create or link one.</p>'}
        </div>
      </div>`;

    document.body.append(box);
    const closeModal = () => { box.close(); box.remove(); };
    box.querySelector('.mp-close').onclick = closeModal;
    box.addEventListener('cancel', e => { e.preventDefault(); closeModal(); });
    box.addEventListener('click', e => { if (e.target === box) closeModal(); });

    const refreshCurrentView = () => {
      if (currentRole === 'owner') renderOwnerMembers();
      else renderStaffMembers();
    };
    const rerenderSelf = () => {
      const still = live.members.find(m => m.id === member.id);
      if (still) openMemberProfileModal(still.id);
      else { closeModal(); refreshCurrentView(); }
    };

    box.querySelector('.renew-now').onclick = () => {
      closeModal();
      openRenewalLive(member.id);
    };

    box.querySelector('.status-toggle').onclick = async () => {
      const next = member.status === 'Active' ? 'Deactivated' : 'Active';
      const ok = await confirmDialog({
        title: next === 'Active' ? 'Reactivate this member?' : 'Deactivate this member?',
        body: next === 'Active' ? 'Reactivating lets them check in again. Confirm only after payment or an owner decision.' : 'Deactivated members can’t check in. The record and history stay available.',
        confirm: next === 'Active' ? 'Reactivate' : 'Deactivate'
      });
      if (!ok) return;
      try {
        await ui.call('set_member_status', { p_member_id: member.id, p_status: next, p_reason: null });
        await refreshData(true);
        refreshCurrentView();
        rerenderSelf();
      } catch (error) { toastLive(friendly(error)); }
    };

    const editForm = box.querySelector('.profile-form');
    if (editForm) editForm.onsubmit = async event => {
      event.preventDefault();
      const fullName = editForm.querySelector('.p-name').value.trim();
      if (!fullName) return toastLive('Full name is required.');
      try {
        await ui.call('update_member_details', {
          p_member_id: member.id,
          p_full_name: fullName,
          p_phone: editForm.querySelector('.p-phone').value.trim() || null,
          p_email: editForm.querySelector('.p-email').value.trim() || null,
          p_address: editForm.querySelector('.p-address').value.trim() || null,
          p_emergency_contact: editForm.querySelector('.p-emergency').value.trim() || null
        });
        toastLive('Changes saved.');
        await refreshData(true);
        refreshCurrentView();
        rerenderSelf();
      } catch (error) { toastLive(friendly(error)); }
    };

    wireMemberActions(member, () => {
      refreshCurrentView();
      rerenderSelf();
    }, box);

    const pwForm = box.querySelector('#member-password-form');
    if (pwForm) {
      const pwInput = pwForm.querySelector('#mp-new-password');
      const pwToggle = pwForm.querySelector('#mp-pw-toggle');
      const pwGen = pwForm.querySelector('#mp-pw-gen');
      const pwSave = pwForm.querySelector('#mp-pw-save');
      if (pwToggle && pwInput) {
        pwToggle.onclick = () => {
          const show = pwInput.type === 'password';
          pwInput.type = show ? 'text' : 'password';
          pwToggle.textContent = show ? 'Hide' : 'Show';
        };
      }
      if (pwGen && pwInput) {
        pwGen.onclick = () => {
          pwInput.value = randomTempPassword().slice(0, 10);
          pwInput.type = 'text';
          if (pwToggle) pwToggle.textContent = 'Hide';
          pwInput.focus();
          pwInput.select();
        };
      }
      pwForm.onsubmit = async event => {
        event.preventDefault();
        const nextPw = pwInput.value;
        if (nextPw.length < 8) return toastLive('Password must be at least 8 characters.');
        pwSave.disabled = true;
        const prevLabel = pwSave.textContent;
        pwSave.textContent = 'Updating…';
        try {
          await ui.call('set_member_password', { p_member_id: member.id, p_new_password: nextPw });
          toastLive(`Portal password updated for ${member.full_name}.`);
          pwInput.value = '';
          pwInput.type = 'password';
          if (pwToggle) pwToggle.textContent = 'Show';
          await refreshData(true);
        } catch (error) {
          toastLive(friendly(error));
        } finally {
          pwSave.disabled = false;
          pwSave.textContent = prevLabel;
        }
      };
    }

    const createButton = box.querySelector('#create-login');
    if (createButton) createButton.onclick = async () => {
      const email = box.querySelector('#login-email').value.trim();
      if (!email) return toastLive('Enter the email to use for signing in.');
      createButton.disabled = true;
      try {
        const result = await createMemberLogin(member.id, email);
        dialog({
          title: 'Portal login created',
          body: `<p style="margin:0 0 14px">Give these details to <b>${esc(result.full_name)}</b>. They sign in at the member portal.</p>
            <div class="wf-row"><span>Member ID</span><strong>${esc(result.member_no)}</strong></div>
            <div class="wf-row"><span>Email</span><strong>${esc(result.email)}</strong></div>
            <div class="wf-row"><span>Password</span><strong style="font-family:ui-monospace,monospace">${esc(result.password)}</strong></div>
            <p class="sub" style="margin-top:14px">This password works every time they sign in and does not expire. It is shown only now, so write it down before closing.</p>`,
          action: 'Done',
          onAction: () => {}
        });
        await refreshData(true);
        refreshCurrentView();
        rerenderSelf();
      } catch (error) { toastLive(loginErrorMessage(error)); }
      finally { createButton.disabled = false; }
    };
    const linkButton = box.querySelector('#link-account');
    if (linkButton) linkButton.onclick = async () => {
      const email = box.querySelector('#link-email').value.trim();
      if (!email) return toastLive('Enter the account email.');
      try {
        await ui.call('link_member_account', { p_member_id: member.id, p_email: email });
        toastLive('Portal account linked.');
        await refreshData(true);
        refreshCurrentView();
        rerenderSelf();
      } catch (error) { toastLive(friendly(error)); }
    };

    box.showModal();
  }

  function showOwnerMember(id) {
    openMemberProfileModal(id);
  }

  /* ---- Portal logins ---------------------------------------------------- */
  // Creates a sign-in account for a member. The service key lives in the Edge Function,
  // never here — the browser only sends its own token and gets back a generated password.
  async function createMemberLogin(memberId, email) {
    const { data: sessionData } = await sb.auth.getSession();
    const token = sessionData?.session?.access_token;
    if (!token) throw new Error('NOT_SIGNED_IN');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/create-member-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ member_id: memberId, email })
    });
    let body = null;
    try { body = await response.json(); } catch (error) { /* non-JSON */ }
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error || `CREATE_FAILED_${response.status}`);
    }
    return body;
  }

  function loginErrorMessage(error) {
    const code = String(error?.message || '');
    const messages = {
      NOT_SIGNED_IN: 'Your session expired. Sign in again.',
      FORBIDDEN: 'Only the owner can create portal logins.',
      EMAIL_INVALID: 'That does not look like an email address.',
      EMAIL_IN_USE: 'An account already uses that email. Use “Link existing account” instead.',
      ALREADY_HAS_LOGIN: 'This member already has a portal login.',
      MEMBER_NOT_FOUND: 'That member no longer exists.',
      CREATE_FAILED: 'Could not create the account. Try again in a moment.'
    };
    const key = Object.keys(messages).find(k => code.includes(k));
    return key ? messages[key] : 'Could not create the login. Try again.';
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
          <button class="outline member-act" id="act-archive">Archive</button>
          ${currentRole === 'owner'
            ? '<button class="outline member-act member-act-danger" id="act-delete">Delete member</button>'
            : (hasPendingApproval('delete_member', member.id)
              ? '<button class="outline member-act member-act-danger" id="act-delete" disabled>Deletion pending owner</button>'
              : '<button class="outline member-act member-act-danger" id="act-delete">Request deletion</button>')}
        </div>`}
    </div>`;
  }

  function wireMemberActions(member, rerender, rootEl) {
    const detail = rootEl || ownerContent.querySelector('#owner-detail');
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
    const delBtn = detail.querySelector('#act-delete');
    if (delBtn) delBtn.onclick = async () => {
      if (currentRole !== 'owner') {
        await requestOwnerApproval('delete_member', member.id, `${member.full_name} (${member.member_no})`, rerender);
        return;
      }
      const ok = await confirmDialog({
        title: `Delete ${member.full_name}?`,
        body: `This permanently deletes <b>${esc(member.full_name)}</b> (${esc(member.member_no)}), their attendance visits, and passes. This cannot be undone — use <b>Archive</b> if you want to keep the profile.<br><br>Proceed with permanent deletion?`,
        confirm: 'Delete permanently'
      });
      if (!ok) return;
      try {
        await ui.call('delete_member', { p_member_id: member.id, p_reason: 'Deleted from dashboard' });
        toastLive(`${member.full_name} deleted.`);
        document.querySelector('#member-profile-dialog')?.close();
        document.querySelector('#member-profile-dialog')?.remove();
        await refreshData(true);
        if (currentRole === 'owner') renderOwnerMembers();
        else renderStaffMembers();
      } catch (error) { toastLive(friendly(error)); }
    };
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

  async function openTeamAccountModal(userId) {
    const account = live.team.find(t => t.id === userId);
    if (!account) return;
    document.querySelector('#team-account-dialog')?.remove();

    const isSelf = account.id === live.profile.id;
    let existingPerms = {};
    try {
      const { data } = await sb.from('staff_permissions').select('*').eq('staff_id', account.id).maybeSingle();
      existingPerms = data || {};
    } catch { /* fallback to defaults */ }

    const box = document.createElement('dialog');
    box.className = 'renew-dialog member-profile-dialog';
    box.id = 'team-account-dialog';
    box.innerHTML = `
      <div class="mp-head">
        <img class="mp-head-watermark" src="green-emblem.png" alt="" aria-hidden="true">
        <div class="mp-head-top">
          <div class="mp-brand">
            <span class="mp-brand-badge"><img src="green-emblem.png" alt="GIMMDA"></span>
            <div>
              <div class="eyebrow">TEAM ACCOUNT</div>
              <span class="mp-brand-sub">GIMMDA · HILL FITNESS GYM</span>
            </div>
          </div>
          <button type="button" class="mp-close" aria-label="Close">×</button>
        </div>
        <div class="mp-identity">
          <div class="mp-avatar"><span>${esc(initials(account.full_name || account.email))}</span></div>
          <div class="mp-id-info">
            <h2>${esc(account.full_name || 'Unnamed account')}</h2>
            <p>${esc(account.email || '')}${isSelf ? ' · Your account' : ''}</p>
          </div>
          <span class="status-tag ${account.is_active ? '' : 'status-deactivated'}">${account.is_active ? 'Active' : 'Deactivated'}</span>
        </div>
        <div class="mp-plan-strip">
          <div><small>ROLE</small><strong>${account.role === 'owner' ? 'Owner' : 'Staff'}</strong></div>
          <div><small>ACCESS</small><strong>${account.is_active ? 'Can sign in' : 'Blocked'}</strong></div>
          <div><small>ADDED</small><strong>${esc(account.created_at ? fmtDay(String(account.created_at).slice(0, 10)) : '—')}</strong></div>
          <div><small>SCOPE</small><strong>${account.role === 'owner' ? 'Full gym' : 'Per permissions'}</strong></div>
        </div>
      </div>

      <form class="mp-body" id="ta-form">
        <div class="mp-card">
          <div class="mp-card-title">ACCOUNT &amp; ROLE <span>Edit &amp; save changes</span></div>
          <div class="modal-two-col">
            <div class="modal-span-2">
              <label class="field" for="ta-name">Full name</label>
              <input class="login-input" id="ta-name" value="${esc(account.full_name || '')}" maxlength="100" placeholder="e.g. Sam Santos" required>
            </div>
            <div>
              <label class="field" for="ta-role">Role</label>
              <select class="login-input" id="ta-role" ${isSelf ? 'disabled' : ''}>
                <option value="owner" ${account.role === 'owner' ? 'selected' : ''}>Owner</option>
                <option value="staff" ${account.role === 'staff' ? 'selected' : ''}>Staff</option>
              </select>
              ${isSelf ? '<p class="sub" style="margin:6px 0 0">You can’t change your own owner role.</p>' : ''}
            </div>
            <div>
              <label class="field" for="ta-active">Account status</label>
              <select class="login-input" id="ta-active" ${isSelf ? 'disabled' : ''}>
                <option value="true" ${account.is_active ? 'selected' : ''}>Active — can sign in</option>
                <option value="false" ${!account.is_active ? 'selected' : ''}>Deactivated — sign-in blocked</option>
              </select>
              ${isSelf ? '<p class="sub" style="margin:6px 0 0">You can’t deactivate your own account.</p>' : ''}
            </div>
          </div>
        </div>

        <div class="mp-card" id="ta-perms-card" ${account.role === 'staff' ? '' : 'hidden'}>
          <div class="mp-card-title">STAFF PERMISSIONS <span>Enforced by database</span></div>
          <div class="perm-list">${PERMISSION_LABELS.map(([key, label, help]) => {
            const on = key === 'can_void' ? existingPerms.can_void === true : existingPerms[key] !== false;
            return `<label class="perm-row"><span><b>${label}</b><small>${help}</small></span><input type="checkbox" data-perm="${key}" ${on ? 'checked' : ''}></label>`;
          }).join('')}</div>
        </div>

        <div class="mp-form-foot" style="padding:0 2px">
          <button type="button" class="outline" id="ta-cancel">Cancel</button>
          <button type="submit" class="login-submit" id="ta-save" style="width:auto;padding:0 20px">Save changes ↗</button>
        </div>

        ${isSelf
          ? `<div class="mp-card"><div class="mp-card-title">SECURITY</div><p class="sub" style="margin:0">To change your own password, open <b>Settings → Account</b>.</p></div>`
          : `<div class="mp-card">
              <div class="mp-card-title">SECURITY &amp; ACCOUNT ACTIONS</div>
              <div class="mp-action-bar">
                <button type="button" class="outline" id="ta-reset">Reset password</button>
                ${account.role === 'staff' ? '<button type="button" class="outline member-act-danger" id="ta-delete">Delete staff</button>' : ''}
              </div>
              <p class="sub" style="margin:10px 0 0">Reset password issues a temporary one-time password and signs out active sessions.${account.role === 'staff' ? ' Deleting permanently removes their login while keeping historical records.' : ''}</p>
            </div>`
        }
      </form>`;

    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.mp-close').onclick = close;
    box.querySelector('#ta-cancel').onclick = close;
    box.addEventListener('cancel', e => { e.preventDefault(); close(); });

    const roleSelect = box.querySelector('#ta-role');
    const permsCard = box.querySelector('#ta-perms-card');
    roleSelect?.addEventListener('change', () => {
      if (permsCard) permsCard.hidden = roleSelect.value !== 'staff';
    });

    box.querySelector('#ta-form').onsubmit = async e => {
      e.preventDefault();
      const saveBtn = box.querySelector('#ta-save');
      const fullName = box.querySelector('#ta-name').value.trim();
      const nextRole = isSelf ? account.role : roleSelect.value;
      const nextActive = isSelf ? true : box.querySelector('#ta-active').value === 'true';
      if (!fullName) return toastLive('Full name is required.');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await ui.call('update_team_account', {
          p_user: account.id,
          p_full_name: fullName,
          p_role: nextRole,
          p_is_active: nextActive
        });
        if (nextRole === 'staff') {
          const permRow = { staff_id: account.id };
          box.querySelectorAll('#ta-perms-card input[data-perm]').forEach(input => {
            permRow[input.dataset.perm] = input.checked;
          });
          const { error: permErr } = await sb.from('staff_permissions').upsert(permRow);
          if (permErr) throw permErr;
        }
        close();
        toastLive('Account changes saved.');
        await refreshData(true);
        if (account.id === live.profile.id) {
          live.profile.full_name = fullName;
          paintGreeting();
        }
        renderOwnerTeam();
      } catch (error) {
        toastLive(friendly(error));
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save changes ↗';
      }
    };

    box.querySelector('#ta-reset')?.addEventListener('click', () => {
      close();
      resetTeamPassword(account);
    });

    box.querySelector('#ta-delete')?.addEventListener('click', async () => {
      const label = account.full_name || account.email || 'this staff member';
      const ok = await confirmDialog({
        title: `Delete ${label}?`,
        body: `This permanently deletes <b>${esc(label)}</b>${account.email ? ` (${esc(account.email)})` : ''}'s staff account and signs them out immediately. Past payments, check-ins, and activity logs they recorded are preserved.<br><br>Switch status to <b>Deactivated</b> instead if you only want to block sign-in temporarily.`,
        confirm: 'Delete staff'
      });
      if (!ok) return;
      const delBtn = box.querySelector('#ta-delete');
      delBtn.disabled = true;
      delBtn.textContent = 'Deleting…';
      try {
        const res = await sb.functions.invoke('delete-staff', { body: { user_id: account.id } });
        if (res.error) throw res.error;
        if (res.data?.error) throw new Error(res.data.detail || res.data.error);
        close();
        toastLive(`${label} deleted.`);
        await refreshData(true);
        renderOwnerTeam();
      } catch (error) {
        toastLive(friendly(error));
        delBtn.disabled = false;
        delBtn.textContent = 'Delete staff';
      }
    });

    box.showModal();
  }

  function openAddStaffModal() {
    document.querySelector('#add-staff-dialog')?.remove();
    const box = document.createElement('dialog');
    box.className = 'renew-dialog member-profile-dialog';
    box.id = 'add-staff-dialog';
    box.innerHTML = `
      <div class="mp-head">
        <img class="mp-head-watermark" src="green-emblem.png" alt="" aria-hidden="true">
        <div class="mp-head-top">
          <div class="mp-brand">
            <span class="mp-brand-badge"><img src="green-emblem.png" alt="GIMMDA"></span>
            <div>
              <div class="eyebrow">NEW TEAM ACCOUNT</div>
              <span class="mp-brand-sub">GIMMDA · HILL FITNESS GYM</span>
            </div>
          </div>
          <button type="button" class="mp-close" aria-label="Close">×</button>
        </div>
        <div class="mp-identity">
          <div class="mp-avatar"><span>+</span></div>
          <div class="mp-id-info">
            <h2>Add team member</h2>
            <p>Create a staff or co-owner login for the gym dashboard.</p>
          </div>
        </div>
      </div>

      <form class="mp-body" id="ns-form">
        <div class="mp-card">
          <div class="mp-card-title">ACCOUNT DETAILS <span>Required</span></div>
          <div class="modal-two-col">
            <div>
              <label class="field" for="ns-name">Full name</label>
              <input class="login-input" id="ns-name" maxlength="100" placeholder="e.g. Sam Santos" required>
            </div>
            <div>
              <label class="field" for="ns-role">Role</label>
              <select class="login-input" id="ns-role">
                <option value="staff" selected>Staff</option>
                <option value="owner">Owner</option>
              </select>
            </div>
            <div>
              <label class="field" for="ns-email">Email address</label>
              <input class="login-input" id="ns-email" type="email" maxlength="140" placeholder="staff@hillfitness.com" required>
            </div>
            <div>
              <label class="field" for="ns-password">Initial password (optional)</label>
              <input class="login-input" id="ns-password" type="password" minlength="8" placeholder="Leave blank to auto-generate">
            </div>
          </div>
          <p class="sub" style="margin:10px 0 0">If left blank, a temporary password is generated and shown once for them to change on first sign-in.</p>
        </div>

        <div class="mp-card" id="ns-perms-card">
          <div class="mp-card-title">STAFF PERMISSIONS <span>Enforced by database</span></div>
          <div class="perm-list">${PERMISSION_LABELS.map(([key, label, help]) => {
            const on = key !== 'can_void';
            return `<label class="perm-row"><span><b>${label}</b><small>${help}</small></span><input type="checkbox" data-perm="${key}" ${on ? 'checked' : ''}></label>`;
          }).join('')}</div>
        </div>

        <div class="mp-form-foot" style="padding:0 2px">
          <button type="button" class="outline" id="ns-cancel">Cancel</button>
          <button type="submit" class="login-submit" id="ns-submit" style="width:auto;padding:0 20px">Create account ↗</button>
        </div>
      </form>`;

    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.mp-close').onclick = close;
    box.querySelector('#ns-cancel').onclick = close;
    box.addEventListener('cancel', e => { e.preventDefault(); close(); });

    const roleSelect = box.querySelector('#ns-role');
    const permsCard = box.querySelector('#ns-perms-card');
    roleSelect.addEventListener('change', () => {
      permsCard.hidden = roleSelect.value !== 'staff';
    });

    box.querySelector('#ns-form').onsubmit = async e => {
      e.preventDefault();
      const btn = box.querySelector('#ns-submit');
      const full_name = box.querySelector('#ns-name').value.trim();
      const email = box.querySelector('#ns-email').value.trim().toLowerCase();
      const role = roleSelect.value;
      const password = box.querySelector('#ns-password').value;
      if (!full_name) return toastLive('Full name is required.');
      if (password && password.length < 8) return toastLive('Password must be at least 8 characters.');

      const permissions = {};
      if (role === 'staff') {
        box.querySelectorAll('#ns-perms-card input[data-perm]').forEach(input => {
          permissions[input.dataset.perm] = input.checked;
        });
      }

      btn.disabled = true;
      btn.textContent = 'Creating…';
      try {
        const res = await sb.functions.invoke('create-staff', {
          body: { full_name, email, role, password: password || undefined, permissions }
        });
        if (res.error) throw res.error;
        if (res.data?.error) throw new Error(res.data.detail || res.data.error);
        const created = res.data || {};
        close();
        await refreshData(true);
        renderOwnerTeam();

        if (created.temp_password) {
          const pwBox = dialog({
            title: 'Staff account created',
            body: `<p><b>${esc(full_name)}</b> (${esc(email)}) can now sign in with this one-time temporary password. They will be prompted to set their own password on first login.</p>
              <label class="field" style="margin-top:16px">Temporary password</label>
              <input class="login-input" id="new-staff-temp-pw" value="${esc(created.temp_password)}" readonly style="font-family:monospace;letter-spacing:.5px">
              <p class="sub" style="margin-top:8px">Copy this now — it will not be shown again.</p>`,
            action: 'Done'
          });
          setTimeout(() => {
            const field = pwBox.querySelector('#new-staff-temp-pw');
            if (field) { field.select(); document.execCommand?.('copy'); }
          }, 120);
        } else {
          toastLive(`${full_name} added to your team.`);
        }
      } catch (error) {
        toastLive(friendly(error));
        btn.disabled = false;
        btn.textContent = 'Create account ↗';
      }
    };

    box.showModal();
    box.querySelector('#ns-name').focus();
  }

  function renderOwnerTeam() {
    const staff = live.team.filter(t => t.role === 'owner' || t.role === 'staff');
    const active = staff.filter(t => t.is_active).length;
    const locked = staff.filter(t => !t.is_active).length;
    const today = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
    const todayActivity = live.activity.filter(a => phDateTime(a.created_at).includes(today)).length;
    const owners = staff.filter(t => t.role === 'owner').length;

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">THE PEOPLE BEHIND HILL</div>
          <h2>Your team</h2>
          <p>Accounts that can sign in to the gym dashboard.</p>
        </div>
        <button type="button" class="login-submit" id="open-add-staff" style="width:auto;padding:0 18px;height:42px">+ Add staff ↗</button>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: 'TEAM ACCOUNTS',
          valueHtml: `<strong>${staff.length}</strong>`,
          sub: `${owners} owner${owners === 1 ? '' : 's'} · ${active} active right now`,
          sparkLabel: '7-DAY ACTIONS',
          sparkPeak: `${todayActivity} today`,
          points: lastDays(7).map(d => live.activity.filter(a => String(a.created_at).slice(0, 10) === d.iso).length),
          split: [['OWNERS', owners], ['STAFF', staff.filter(t => t.role === 'staff').length], ['DEACTIVATED', locked]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>ACTIVE</small><strong>${active}</strong><em>can sign in</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>DEACTIVATED</small><strong>${locked}</strong><em>access blocked</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>ACTIVITY TODAY</small><strong>${todayActivity}</strong><em>logged actions</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>OWNERS</small><strong>${owners}</strong><em>full access</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card owner-directory">
          <div class="panel-head"><div><div class="staff-kicker">ACCESS CONTROL</div><h3>Team accounts</h3><p>Click View on any account to update their name, role, permissions, or access.</p></div></div>
          <div id="team-list">${staff.map(t => `<div class="team-account" data-id="${t.id}">
            <div class="team-person">
              <span class="team-avatar">${esc(initials(t.full_name || t.email))}</span>
              <div>
                <strong>${esc(t.full_name || 'Unnamed account')}${t.id === live.profile.id ? '<span class="team-you">You</span>' : ''}</strong>
                <small>${esc(t.email || '')}</small>
              </div>
            </div>
            <div class="team-row-meta">
              <span class="team-role-pill ${t.role === 'owner' ? 'is-owner' : ''}">${t.role === 'owner' ? 'Owner' : 'Staff'}</span>
              <span class="status-tag ${t.is_active ? '' : 'status-deactivated'}">${t.is_active ? 'Active' : 'Deactivated'}</span>
              <button type="button" class="outline team-view" data-id="${t.id}">View ↗</button>
            </div>
          </div>`).join('') || '<p class="sub">No accounts yet.</p>'}</div>
          <div class="settings-notice" style="margin-top:14px">✳ &nbsp; Use <b>+ Add staff ↗</b> to create a new staff or co-owner login. Member logins are managed from the <b>Members</b> tab.</div>
        </section>

        <div class="rp-side-stack">
          <aside class="card owner-member-detail">
            <div id="lockouts"></div>
            <div class="team-activity-head">
              <div class="staff-kicker" style="margin:0">TEAM ACTIVITY</div>
              ${live.activity.length ? `<button type="button" class="team-view-all" id="team-view-activity">View all (${live.activity.length}) ↗</button>` : ''}
            </div>
            <div class="team-activity-scroll">${live.activity.slice(0, 25).map(a => `<div class="team-activity-item"><div>${esc(a.summary)}</div><small>${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</small></div>`).join('') || '<p class="sub" style="padding-top:10px">No activity yet.</p>'}</div>
          </aside>
          <section class="card rp-new-card">
            <div class="panel-head"><div><div class="staff-kicker">ROLES AT A GLANCE</div><h3>Who can do what</h3><p>Permissions are enforced by the database, not just hidden on screen.</p></div></div>
            <div class="team-role"><span class="team-role-icon">♙</span><div><strong>Owner</strong><small>Everything — pricing, staff, voids, finance and settings.</small></div></div>
            <div class="team-role"><span class="team-role-icon">✳</span><div><strong>Staff</strong><small>Payments, check-ins, walk-ins and selling, per permission.</small></div></div>
          </section>
        </div>
      </div>`;
    ownerContent.querySelector('#open-add-staff')?.addEventListener('click', openAddStaffModal);
    ownerContent.querySelectorAll('.team-view').forEach(btn => {
      btn.onclick = () => openTeamAccountModal(btn.dataset.id);
    });
    ownerContent.querySelector('#team-view-activity')?.addEventListener('click', () => {
      const btn = [...ownerNav.querySelectorAll('button')].find(b => b.textContent.trim() === 'Activity');
      btn?.click();
    });
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
    const range = currentPeriodRange();
    const inRange = date => date && date.slice(0, 10) >= range.from && date.slice(0, 10) <= range.to;
    const live$ = row => !row.voided_at;
    const payments = live.payments.filter(p => p.status === 'approved' && live$(p) && inRange(p.paid_on));
    const membership = payments.filter(p => p.category === 'membership').reduce((n, p) => n + Number(p.amount), 0);
    const walkin = live.walkins.filter(w => live$(w) && inRange(w.visited_on)).reduce((n, w) => n + Number(w.amount), 0);
    const product = live.sales.filter(s => live$(s) && inRange(s.sold_on)).reduce((n, s) => n + Number(s.total), 0);
    const reversed = [
      ...live.payments.filter(p => p.voided_at && inRange(p.paid_on)).map(p => ({ ref: p.receipt_no, amount: Number(p.amount) })),
      ...live.walkins.filter(w => w.voided_at && inRange(w.visited_on)).map(w => ({ ref: w.receipt_no, amount: Number(w.amount) })),
      ...live.sales.filter(s => s.voided_at && inRange(s.sold_on)).map(s => ({ ref: s.receipt_no, amount: Number(s.total) }))
    ];
    const reversedTotal = reversed.reduce((n, r) => n + r.amount, 0);
    const total = membership + walkin + product;

    const transactions = [
      ...live.payments.filter(p => inRange(p.paid_on)).map(p => ({ id: p.id, kind: 'payment', name: p.member_name || (live.members.find(m => m.id === p.member_id) || {}).full_name || 'Member', type: p.receipt_no, category: 'Membership', date: p.paid_on, method: p.method, amount: Number(p.amount), status: p.status, voided: !!p.voided_at, reason: p.void_reason })),
      ...live.walkins.filter(w => inRange(w.visited_on)).map(w => ({ id: w.id, kind: 'walkin', name: w.visitor_name || 'Walk-in guest', type: w.receipt_no, category: 'Walk-in', date: w.visited_on, method: w.method, amount: Number(w.amount), status: w.voided_at ? 'voided' : 'approved', voided: !!w.voided_at, reason: w.void_reason })),
      ...live.sales.filter(s => inRange(s.sold_on)).map(s => ({ id: s.id, kind: 'sale', name: s.customer_name || 'Walk-in customer', type: s.receipt_no, category: 'Product', date: s.sold_on, method: s.method, amount: Number(s.total), status: s.voided_at ? 'voided' : 'approved', voided: !!s.voided_at, reason: s.void_reason }))
    ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

    const methodTotals = {};
    [...payments.map(p => ({ m: p.method, a: Number(p.amount) })),
     ...live.walkins.filter(w => live$(w) && inRange(w.visited_on)).map(w => ({ m: w.method, a: Number(w.amount) })),
     ...live.sales.filter(x => live$(x) && inRange(x.sold_on)).map(x => ({ m: x.method, a: Number(x.total) }))]
      .forEach(r => { methodTotals[r.m || 'Other'] = (methodTotals[r.m || 'Other'] || 0) + r.a; });
    const methodRows = Object.entries(methodTotals).sort((a, b) => b[1] - a[1]);

    if (!live.reportsUi) live.reportsUi = { q: '', type: 'all', page: 1 };

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">TRANSACTIONS &amp; RECONCILIATION</div>
          <h2>Gym reports</h2>
          <p>Every recorded receipt and payment method split · ${periodText(true)}</p>
        </div>
        <button type="button" class="login-submit" id="report-export" style="width:auto;padding:0 18px;height:42px">Export CSV ↓</button>
      </div>

      <div class="reports-summary">
        <div class="reports-total-card">
          <div>
            <div class="staff-kicker">NET COLLECTED · ${periodText().toUpperCase()}</div>
            <div class="reports-total-val">${peso(total)}</div>
            <div class="reports-total-sub">${transactions.length} receipt${transactions.length === 1 ? '' : 's'}${reversed.length ? ` · −${peso(reversedTotal)} voided (${reversed.length})` : ''}</div>
          </div>
          <div class="reports-splits">
            <div><small>MEMBERSHIPS</small><strong>${peso(membership)}</strong></div>
            <div><small>WALK-INS</small><strong>${peso(walkin)}</strong></div>
            <div><small>PRODUCTS</small><strong>${peso(product)}</strong></div>
          </div>
        </div>

        <section class="card reports-mix-card">
          <div class="panel-head"><div><div class="staff-kicker">RECONCILIATION</div><h3>Payment mix</h3></div></div>
          ${methodRows.length ? `<div class="reports-mix-pills">${methodRows.map(([name, amount]) => `
            <div class="reports-mix-row"><span>${esc(name)}</span><strong>${peso(amount)}</strong></div>`).join('')}</div>`
            : '<p class="sub" style="margin:0">No payments recorded in this period yet.</p>'}
        </section>
      </div>

      <section class="card page-panel rp-table-card">
        <div class="panel-head"><div><div class="staff-kicker">THE LEDGER</div><h3>Transactions</h3><p>Search, filter, void mistakes, or export receipts for ${periodText(true)}.</p></div></div>
        <div class="reports-toolbar">
          <input class="login-input" id="rp-tx-search" placeholder="Search person or receipt number…" value="${esc(live.reportsUi.q)}">
          <select class="login-input" id="rp-tx-type" aria-label="Filter transactions by type">
            <option value="all" ${live.reportsUi.type === 'all' ? 'selected' : ''}>All types</option>
            <option value="Membership" ${live.reportsUi.type === 'Membership' ? 'selected' : ''}>Memberships</option>
            <option value="Walk-in" ${live.reportsUi.type === 'Walk-in' ? 'selected' : ''}>Walk-ins</option>
            <option value="Product" ${live.reportsUi.type === 'Product' ? 'selected' : ''}>Products</option>
            <option value="voided" ${live.reportsUi.type === 'voided' ? 'selected' : ''}>Voided only</option>
          </select>
        </div>
        <div class="report-table-wrap">
          <table class="report-table">
            <thead><tr><th>PERSON / REFERENCE</th><th>TYPE</th><th>DATE</th><th>METHOD</th><th>STATUS</th><th>AMOUNT</th><th></th></tr></thead>
            <tbody id="rp-tx-body"></tbody>
          </table>
        </div>
        <div id="rp-tx-pager"></div>
      </section>`;

    const searchInput = ownerContent.querySelector('#rp-tx-search');
    const typeSelect = ownerContent.querySelector('#rp-tx-type');
    const tbody = ownerContent.querySelector('#rp-tx-body');
    const pagerEl = ownerContent.querySelector('#rp-tx-pager');

    const getFiltered = () => {
      const q = (live.reportsUi.q || '').trim().toLowerCase();
      const t = live.reportsUi.type || 'all';
      return transactions.filter(row => {
        if (t === 'voided' && !row.voided) return false;
        if (t !== 'all' && t !== 'voided' && row.category !== t) return false;
        if (!q) return true;
        return (row.name || '').toLowerCase().includes(q)
          || (row.type || '').toLowerCase().includes(q)
          || (row.method || '').toLowerCase().includes(q);
      });
    };

    const drawLedger = () => {
      const filtered = getFiltered();
      const perPage = 12;
      const pages = Math.max(1, Math.ceil(filtered.length / perPage));
      live.reportsUi.page = Math.min(Math.max(1, live.reportsUi.page), pages);
      const start = (live.reportsUi.page - 1) * perPage;
      const slice = filtered.slice(start, start + perPage);

      tbody.innerHTML = slice.length ? slice.map(t => `<tr class="${t.voided ? 'row-is-voided' : ''}">
        <td><strong>${esc(t.name)}</strong><small>${esc(t.type)}</small></td>
        <td><span class="report-type ${t.category === 'Walk-in' ? 'walk' : ''}">${t.category}</span></td>
        <td>${esc(fmtDay(t.date))}</td>
        <td>${esc(t.method)}</td>
        <td><span class="status-tag${t.voided ? ' status-deactivated' : ''}">${esc(t.status)}</span>${t.voided && t.reason ? `<small class="void-reason">${esc(t.reason)}</small>` : ''}</td>
        <td class="report-amount${t.voided ? ' voided-amount' : ''}">${peso(t.amount)}</td>
        <td>${!t.voided && t.status !== 'pending' ? `<button class="outline row-void" data-id="${t.id}" data-kind="${t.kind}" data-ref="${esc(t.type)}">Void</button>` : ''}</td>
      </tr>`).join('') : '<tr><td colspan="7" class="report-empty">No matching transactions in this period.</td></tr>';

      tbody.querySelectorAll('.row-void').forEach(button => {
        button.onclick = () => voidTransaction(button.dataset.kind, button.dataset.id, button.dataset.ref);
      });

      if (pages <= 1) {
        pagerEl.innerHTML = filtered.length ? `<div class="owner-pager" style="margin-top:12px"><span>Showing ${filtered.length} receipt${filtered.length === 1 ? '' : 's'}</span></div>` : '';
      } else {
        const nums = Array.from({ length: pages }, (_, i) => i + 1)
          .filter(n => n === 1 || n === pages || Math.abs(n - live.reportsUi.page) <= 1);
        const pills = nums.map((n, idx) => {
          const gap = idx > 0 && n - nums[idx - 1] > 1 ? '<span class="owner-pager-dots">…</span>' : '';
          return `${gap}<button type="button" class="owner-page-num ${n === live.reportsUi.page ? 'is-active' : ''}" data-rp-page="${n}">${n}</button>`;
        }).join('');
        pagerEl.innerHTML = `<div class="owner-pager" style="margin-top:12px">
          <span>Showing ${start + 1}–${Math.min(start + slice.length, filtered.length)} of ${filtered.length}</span>
          <div class="owner-pager-btns">
            <button type="button" class="outline" id="rp-prev" ${live.reportsUi.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
            ${pills}
            <button type="button" class="outline" id="rp-next" ${live.reportsUi.page >= pages ? 'disabled' : ''}>Next ›</button>
          </div>
        </div>`;
        pagerEl.querySelector('#rp-prev')?.addEventListener('click', () => { live.reportsUi.page -= 1; drawLedger(); });
        pagerEl.querySelector('#rp-next')?.addEventListener('click', () => { live.reportsUi.page += 1; drawLedger(); });
        pagerEl.querySelectorAll('[data-rp-page]').forEach(btn => btn.addEventListener('click', () => {
          live.reportsUi.page = Number(btn.dataset.rpPage);
          drawLedger();
        }));
      }
    };

    searchInput.addEventListener('input', () => {
      live.reportsUi.q = searchInput.value;
      live.reportsUi.page = 1;
      drawLedger();
    });
    typeSelect.addEventListener('change', () => {
      live.reportsUi.type = typeSelect.value;
      live.reportsUi.page = 1;
      drawLedger();
    });
    ownerContent.querySelector('#report-export').onclick = () => {
      const rows = getFiltered();
      downloadCsv('gimmda-transactions.csv', [
        ['Name', 'Reference', 'Type', 'Date', 'Method', 'Status', 'Amount'],
        ...rows.map(t => [t.name, t.type, t.category, t.date, t.method, t.status, t.amount])
      ]);
    };

    drawLedger();
  }

  const analyticsCache = new Map();
  const dayDetailCache = new Map();
  const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function renderOwnerAnalytics() {
    const today = phToday();
    const [curY, curM] = today.split('-').map(Number);
    if (!live.cal) {
      live.cal = {
        mode: 'month',
        year: curY,
        month: curM - 1,
        selectedDate: today,
        customFrom: today.slice(0, 8) + '01',
        customTo: today
      };
    }
    const cal = live.cal;

    const getRange = () => {
      if (cal.mode === 'year') {
        return { from: `${cal.year}-01-01`, to: `${cal.year}-12-31`, label: `Full year ${cal.year}` };
      }
      if (cal.mode === 'custom') {
        const from = cal.customFrom || today.slice(0, 8) + '01';
        const to = (cal.customTo && cal.customTo >= from) ? cal.customTo : from;
        return { from, to, label: `${fmtDay(from)} – ${fmtDay(to)}` };
      }
      const start = new Date(Date.UTC(cal.year, cal.month, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(cal.year, cal.month + 1, 0)).toISOString().slice(0, 10);
      return { from: start, to: end, label: `${MONTH_NAMES[cal.month]} ${cal.year}` };
    };

    const range = getRange();
    if (!cal.selectedDate || cal.selectedDate < range.from || cal.selectedDate > range.to) {
      cal.selectedDate = (today >= range.from && today <= range.to) ? today : range.from;
    }

    const baseYears = [];
    for (let y = curY; y >= Math.max(2020, curY - 6); y -= 1) baseYears.push(y);

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">CALENDAR ANALYTICS</div>
          <h2>Historical calendar &amp; trends</h2>
          <p>Backtrack any day, month, or year across revenue, check-ins, and growth · ${esc(range.label)}</p>
        </div>
      </div>

      <div class="ca-toolbar">
        <div class="ca-toolbar-top">
          <div class="ca-modes" role="tablist" aria-label="Calendar view mode">
            <button type="button" class="ca-mode ${cal.mode === 'month' ? 'active' : ''}" data-ca-mode="month">Month calendar</button>
            <button type="button" class="ca-mode ${cal.mode === 'year' ? 'active' : ''}" data-ca-mode="year">Year overview</button>
            <button type="button" class="ca-mode ${cal.mode === 'custom' ? 'active' : ''}" data-ca-mode="custom">Custom range</button>
          </div>
          <div class="ca-nav-controls" id="ca-controls"></div>
        </div>
        <div class="ca-quick-row">
          <span class="ca-quick-label">Quick jump</span>
          <button type="button" class="ca-chip" data-ca-quick="this_month">This month</button>
          <button type="button" class="ca-chip" data-ca-quick="last_month">Last month</button>
          <button type="button" class="ca-chip" data-ca-quick="three_months">3 months ago</button>
          <button type="button" class="ca-chip" data-ca-quick="this_year">This year</button>
          <button type="button" class="ca-chip" data-ca-quick="last_year">Last year</button>
        </div>
      </div>

      <div id="ca-body"></div>`;

    const controlsEl = ownerContent.querySelector('#ca-controls');
    const bodyEl = ownerContent.querySelector('#ca-body');
    const shiftMonth = delta => {
      const dt = new Date(Date.UTC(curY, curM - 1 + delta, 1));
      return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() };
    };
    const isQuick = id => {
      const m1 = shiftMonth(-1), m3 = shiftMonth(-3);
      if (id === 'this_month') return cal.mode === 'month' && cal.year === curY && cal.month === curM - 1;
      if (id === 'last_month') return cal.mode === 'month' && cal.year === m1.y && cal.month === m1.m;
      if (id === 'three_months') return cal.mode === 'month' && cal.year === m3.y && cal.month === m3.m;
      if (id === 'this_year') return cal.mode === 'year' && cal.year === curY;
      if (id === 'last_year') return cal.mode === 'year' && cal.year === curY - 1;
      return false;
    };
    ownerContent.querySelectorAll('[data-ca-quick]').forEach(chip => {
      chip.classList.toggle('active', isQuick(chip.dataset.caQuick));
      chip.onclick = () => {
        const q = chip.dataset.caQuick;
        if (q === 'this_month') { cal.mode = 'month'; cal.year = curY; cal.month = curM - 1; cal.selectedDate = today; }
        else if (q === 'last_month') { const d = shiftMonth(-1); cal.mode = 'month'; cal.year = d.y; cal.month = d.m; }
        else if (q === 'three_months') { const d = shiftMonth(-3); cal.mode = 'month'; cal.year = d.y; cal.month = d.m; }
        else if (q === 'this_year') { cal.mode = 'year'; cal.year = curY; }
        else if (q === 'last_year') { cal.mode = 'year'; cal.year = curY - 1; }
        renderOwnerAnalytics();
      };
    });

    const paintControls = (yearsList = baseYears) => {
      const years = [...new Set([...yearsList, ...baseYears, cal.year])].sort((a, b) => b - a);
      if (cal.mode === 'custom') {
        controlsEl.innerHTML = `
          <input type="date" class="ca-date-input" id="ca-from" value="${esc(cal.customFrom)}" max="${today}" aria-label="From date">
          <span style="color:#7f8e82;font-weight:600">to</span>
          <input type="date" class="ca-date-input" id="ca-to" value="${esc(cal.customTo)}" max="${today}" aria-label="To date">
          <button type="button" class="outline" id="ca-apply-custom">Apply</button>
          <button type="button" class="outline" id="ca-export">Export CSV ↓</button>`;
        controlsEl.querySelector('#ca-apply-custom').onclick = () => {
          const from = controlsEl.querySelector('#ca-from').value;
          const to = controlsEl.querySelector('#ca-to').value;
          if (!from || !to || to < from) return toastLive('End date must be on or after the start date.');
          cal.customFrom = from;
          cal.customTo = to;
          cal.selectedDate = from;
          renderOwnerAnalytics();
        };
      } else {
        controlsEl.innerHTML = `
          <button type="button" class="ca-step" id="ca-prev" title="${cal.mode === 'year' ? 'Previous year' : 'Previous month'}" aria-label="Previous">‹</button>
          ${cal.mode === 'month' ? `<select class="ca-select" id="ca-month" aria-label="Select month">${MONTH_NAMES.map((m, idx) => `<option value="${idx}" ${idx === cal.month ? 'selected' : ''}>${m}</option>`).join('')}</select>` : ''}
          <select class="ca-select" id="ca-year" aria-label="Select year">${years.map(y => `<option value="${y}" ${y === cal.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
          <button type="button" class="ca-step" id="ca-next" title="${cal.mode === 'year' ? 'Next year' : 'Next month'}" aria-label="Next">›</button>
          <button type="button" class="outline" id="ca-today">Today</button>
          <button type="button" class="outline" id="ca-export">Export CSV ↓</button>`;
        controlsEl.querySelector('#ca-prev').onclick = () => {
          if (cal.mode === 'year') { cal.year -= 1; }
          else {
            cal.month -= 1;
            if (cal.month < 0) { cal.month = 11; cal.year -= 1; }
          }
          renderOwnerAnalytics();
        };
        controlsEl.querySelector('#ca-next').onclick = () => {
          if (cal.mode === 'year') { cal.year += 1; }
          else {
            cal.month += 1;
            if (cal.month > 11) { cal.month = 0; cal.year += 1; }
          }
          renderOwnerAnalytics();
        };
        const mSel = controlsEl.querySelector('#ca-month');
        if (mSel) mSel.onchange = () => { cal.month = Number(mSel.value); renderOwnerAnalytics(); };
        const ySel = controlsEl.querySelector('#ca-year');
        if (ySel) ySel.onchange = () => { cal.year = Number(ySel.value); renderOwnerAnalytics(); };
        controlsEl.querySelector('#ca-today').onclick = () => {
          cal.year = curY;
          cal.month = curM - 1;
          cal.selectedDate = today;
          renderOwnerAnalytics();
        };
      }
      const expBtn = controlsEl.querySelector('#ca-export');
      if (expBtn) expBtn.onclick = () => {
        const snap = analyticsCache.get(`${range.from}:${range.to}`);
        const rows = (snap?.days || []).map(d => [d.date, d.membership, d.walkin, d.product, d.revenue, d.expenses, d.net_profit, d.checkins, d.new_members]);
        downloadCsv(`gimmda-analytics-${range.from}-to-${range.to}.csv`, [['Date', 'Membership', 'Walk-in', 'Products', 'Total Revenue', 'Expenses', 'Net Profit', 'Check-ins', 'New Members'], ...rows]);
      };
    };

    ownerContent.querySelectorAll('[data-ca-mode]').forEach(btn => {
      btn.onclick = () => {
        cal.mode = btn.dataset.caMode;
        renderOwnerAnalytics();
      };
    });

    const deltaBadge = (cur, prev) => {
      const c = Number(cur || 0);
      const p = Number(prev || 0);
      if (p === 0 && c === 0) return '<span class="ca-delta flat">0% vs prior</span>';
      if (p === 0 && c > 0) return '<span class="ca-delta up">New vs prior</span>';
      const pct = Math.round(((c - p) / p) * 100);
      const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
      const sign = pct > 0 ? '+' : '';
      return `<span class="ca-delta ${cls}">${sign}${pct}% vs prior</span>`;
    };

    const paintAnalytics = data => {
      if (!bodyEl.isConnected) return;
      paintControls(data.available_years || baseYears);
      const t = data.totals || {};
      const prev = data.previous || {};
      const days = data.days || [];
      const dayMap = new Map(days.map(d => [String(d.date).slice(0, 10), d]));
      const monthsMap = new Map((data.months || []).map(m => [m.month, m]));
      const peakRev = Math.max(1, ...days.map(d => Number(d.revenue || 0)));

      let centerMarkup = '';
      const compactPeso = n => {
        const v = Number(n || 0);
        if (v >= 1000000) return `₱${(v / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
        if (v >= 1000) return `₱${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        return `₱${Math.round(v)}`;
      };
      if (cal.mode === 'year') {
        const maxMonthRev = Math.max(1, ...MONTH_SHORT.map((_, idx) => Number((monthsMap.get(`${cal.year}-${String(idx + 1).padStart(2, '0')}`) || {}).revenue || 0)));
        const peakMonthIdx = MONTH_SHORT.reduce((best, _, idx) => {
          const r = Number((monthsMap.get(`${cal.year}-${String(idx + 1).padStart(2, '0')}`) || {}).revenue || 0);
          const br = Number((monthsMap.get(`${cal.year}-${String(best + 1).padStart(2, '0')}`) || {}).revenue || 0);
          return r > br ? idx : best;
        }, 0);
        const peakMonthVal = Number((monthsMap.get(`${cal.year}-${String(peakMonthIdx + 1).padStart(2, '0')}`) || {}).revenue || 0);
        const monthTiles = MONTH_SHORT.map((name, idx) => {
          const ym = `${cal.year}-${String(idx + 1).padStart(2, '0')}`;
          const row = monthsMap.get(ym) || { revenue: 0, expenses: 0, net_profit: 0, checkins: 0, new_members: 0 };
          const hasRev = Number(row.revenue) > 0 || Number(row.checkins) > 0;
          const isPeak = peakMonthVal > 0 && idx === peakMonthIdx;
          const barPct = Number(row.revenue) > 0 ? Math.max(8, Math.round((Number(row.revenue) / maxMonthRev) * 100)) : 0;
          return `<button type="button" class="ca-month-tile ${hasRev ? 'has-rev' : ''} ${isPeak ? 'is-peak' : ''}" data-jump-month="${idx}">
            <div>
              <div class="ca-month-head"><strong>${name} ${cal.year}</strong>${isPeak ? '<span class="ca-peak-pill">★ Peak</span>' : `<span>${row.checkins || 0} visits</span>`}</div>
              <div class="ca-month-rev">${peso(row.revenue || 0)}</div>
            </div>
            <div>
              <div class="ca-month-bar"><i style="width:${barPct}%"></i></div>
              <div class="ca-month-meta"><span>Net ${peso(row.net_profit || 0)}</span><span>+${row.new_members || 0} members</span></div>
            </div>
          </button>`;
        }).join('');
        centerMarkup = `
          <div class="ca-year-grid">${monthTiles}</div>
          <section class="card rp-chart-card" style="margin-bottom:16px">
            <div class="panel-head"><div><div class="staff-kicker">ANNUAL TRAJECTORY</div><h3>${cal.year} month-by-month revenue</h3><p>Click any month card or column to open its day-by-day calendar.</p></div>
              <div class="rp-legend"><span><i class="rp-dot rp-dot-m"></i>Memberships</span><span><i class="rp-dot rp-dot-w"></i>Walk-ins</span><span><i class="rp-dot rp-dot-p"></i>Products</span></div>
            </div>
            <div class="rp-chart">
              ${MONTH_SHORT.map((name, idx) => {
                const row = monthsMap.get(`${cal.year}-${String(idx + 1).padStart(2, '0')}`) || { membership: 0, walkin: 0, product: 0, revenue: 0 };
                const h = v => (Number(v || 0) / maxMonthRev) * 100;
                const hasAny = Number(row.revenue) > 0;
                return `<div class="rp-bar-wrap is-clickable" data-jump-month="${idx}" title="${name} ${cal.year} · ${peso(row.revenue)}"><div class="rp-bar">
                  ${hasAny ? `${row.product ? `<i class="rp-seg rp-dot-p" style="height:${h(row.product)}%"></i>` : ''}${row.walkin ? `<i class="rp-seg rp-dot-w" style="height:${h(row.walkin)}%"></i>` : ''}${row.membership ? `<i class="rp-seg rp-dot-m" style="height:${h(row.membership)}%"></i>` : ''}` : '<i class="rp-seg rp-seg-empty" style="height:8%"></i>'}
                </div><span>${name}</span></div>`;
              }).join('')}
            </div>
          </section>`;
      } else {
        // Month grid (or custom range starting month calendar)
        const refDate = cal.mode === 'custom' ? cal.customFrom : `${cal.year}-${String(cal.month + 1).padStart(2, '0')}-01`;
        const [gy, gm] = refDate.split('-').map(Number);
        const firstDow = new Date(Date.UTC(gy, gm - 1, 1)).getUTCDay();
        const totalDays = new Date(Date.UTC(gy, gm, 0)).getUTCDate();
        const cells = [];
        for (let i = 0; i < firstDow; i += 1) cells.push('<div class="ca-cell is-empty" aria-hidden="true"></div>');
        for (let d = 1; d <= totalDays; d += 1) {
          const iso = `${gy}-${String(gm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const info = dayMap.get(iso);
          const rev = Number(info?.revenue || 0);
          const visits = Number(info?.checkins || 0);
          const lvl = rev <= 0 && visits <= 0 ? '' : rev >= peakRev * 0.65 ? 'lvl-3' : rev >= peakRev * 0.25 ? 'lvl-2' : 'lvl-1';
          const cls = ['ca-cell', lvl, iso === today ? 'is-today' : '', iso === cal.selectedDate ? 'is-selected' : ''].filter(Boolean).join(' ');
          cells.push(`<button type="button" class="${cls}" data-ca-date="${iso}">
            <div class="ca-cell-top"><span class="ca-cell-num">${d}</span>${visits ? `<span class="ca-cell-visits" title="${visits} check-ins">${visits}</span>` : ''}</div>
            <div>${rev > 0 ? `<div class="ca-cell-rev"><span class="ca-cell-rev-full">${peso(rev).replace('.00', '')}</span><span class="ca-cell-rev-short">${compactPeso(rev)}</span></div>` : ''}
            ${info?.new_members ? `<div class="ca-cell-sub">+${info.new_members} joined</div>` : ''}</div>
          </button>`);
        }
        centerMarkup = `
          <div class="ca-split">
            <section class="ca-cal-card">
              <div class="panel-head" style="margin-bottom:12px">
                <div><div class="staff-kicker">DAY-BY-DAY CALENDAR</div><h3>${MONTH_NAMES[gm - 1]} ${gy}</h3><p>Click any date to inspect that day’s takings, check-ins, and sign-ups.</p></div>
              </div>
              <div class="ca-weekdays"><span>SUN</span><span>MON</span><span>TUE</span><span>WED</span><span>THU</span><span>FRI</span><span>SAT</span></div>
              <div class="ca-cal-grid">${cells.join('')}</div>
              <div class="ca-legend">
                <span>${days.length} active day${days.length === 1 ? '' : 's'} in range</span>
                <span class="ca-legend-scale">Less <i style="background:#fbfcfa"></i><i style="background:#f2f8ea"></i><i style="background:#e3f2d3"></i><i style="background:#c8e7aa"></i> More</span>
              </div>
            </section>
            <section class="ca-day-card" id="ca-day-inspector">
              <div id="ca-day-body"><p class="sub">Loading day breakdown…</p></div>
            </section>
          </div>`;
      }

      const hoursMap = new Map((data.peak_hours || []).map(h => [Number(h.hour), Number(h.count)]));
      const hourSlots = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
      const maxHour = Math.max(1, ...hourSlots.map(h => hoursMap.get(h) || 0));
      const methods = data.methods || [];
      const maxMethod = Math.max(1, ...methods.map(m => Number(m.total || 0)));

      bodyEl.innerHTML = `
        <div class="rp-top">
          ${bentoHero({
            label: `REVENUE · ${range.label.toUpperCase()}`,
            valueHtml: `<strong>${peso(t.revenue || 0)}</strong>${deltaBadge(t.revenue, prev.revenue)}`,
            sub: `${t.payment_count || 0} membership · ${t.walkin_count || 0} walk-in · ${t.sale_count || 0} product sales`,
            sparkLabel: 'DAILY PULSE',
            sparkPeak: days.length ? `Peak ${peso(peakRev)}` : 'No activity in range',
            points: days.slice(-10).map(d => Number(d.revenue || 0)),
            split: [
              ['MEMBERSHIPS', peso(t.membership || 0)],
              ['WALK-INS', peso(t.walkin || 0)],
              ['PRODUCTS', peso(t.product || 0)]
            ]
          })}
          <div class="rp-kpis">
            <article class="rp-kpi"><span class="rp-kpi-icon">₱</span><div><small>NET PROFIT</small><strong>${peso(t.net_profit || 0)}</strong><em>${peso(t.expenses || 0)} expenses</em></div></article>
            <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>CHECK-INS</small><strong>${t.checkins || 0}</strong><em>${t.unique_visitors || 0} unique members</em></div></article>
            <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>NEW MEMBERS</small><strong>${t.new_members || 0}</strong><em>joined in selected range</em></div></article>
            <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>ACTIVE DAYS</small><strong>${days.length}</strong><em>with takings or visits</em></div></article>
          </div>
        </div>

        ${centerMarkup}

        <div class="rp-mid">
          <section class="card rp-chart-card">
            <div class="panel-head"><div><div class="staff-kicker">TRAFFIC PATTERN</div><h3>Peak gym hours</h3><p>Check-in timing across ${esc(range.label)}.</p></div></div>
            <div class="ca-hours" style="grid-template-columns:repeat(${hourSlots.length},minmax(0,1fr))">
              ${hourSlots.map(h => {
                const cnt = hoursMap.get(h) || 0;
                const pct = cnt ? Math.max(12, Math.round((cnt / maxHour) * 100)) : 8;
                const lbl = h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`;
                return `<div class="ca-hour-col" title="${lbl}: ${cnt} check-in${cnt === 1 ? '' : 's'}"><div class="ca-hour-bar ${cnt ? '' : 'empty'}" style="height:${pct}%"></div><span>${lbl}</span></div>`;
              }).join('')}
            </div>
          </section>

          <section class="card rp-mix-card">
            <div class="panel-head"><div><div class="staff-kicker">PAYMENT CHANNELS</div><h3>How members paid</h3><p>Breakdown for ${esc(range.label)}.</p></div></div>
            ${methods.length ? methods.map(m => `
              <div class="rp-method">
                <div class="rp-method-head"><span>${esc(m.method)}</span><b>${peso(m.total)}</b></div>
                <div class="rp-method-bar"><span style="width:${Math.round((Number(m.total) / maxMethod) * 100)}%"></span></div>
              </div>`).join('') : '<p class="sub">No payments recorded in this period.</p>'}
          </section>
        </div>`;

      bodyEl.querySelectorAll('[data-jump-month]').forEach(tile => {
        tile.onclick = () => {
          cal.month = Number(tile.dataset.jumpMonth);
          cal.mode = 'month';
          cal.selectedDate = `${cal.year}-${String(cal.month + 1).padStart(2, '0')}-01`;
          renderOwnerAnalytics();
        };
      });

      bodyEl.querySelectorAll('[data-ca-date]').forEach(cell => {
        cell.onclick = () => {
          cal.selectedDate = cell.dataset.caDate;
          bodyEl.querySelectorAll('[data-ca-date]').forEach(c => c.classList.toggle('is-selected', c.dataset.caDate === cal.selectedDate));
          loadDayInspector(cal.selectedDate);
        };
      });

      if (cal.mode !== 'year') loadDayInspector(cal.selectedDate);
    };

    const loadDayInspector = async dateStr => {
      const slot = bodyEl.querySelector('#ca-day-body');
      if (!slot || !slot.isConnected) return;
      const stepDay = delta => {
        const [yy, mm, dd] = dateStr.split('-').map(Number);
        const dt = new Date(Date.UTC(yy, mm - 1, dd + delta));
        const nextIso = dt.toISOString().slice(0, 10);
        const ny = dt.getUTCFullYear();
        const nm = dt.getUTCMonth();
        cal.selectedDate = nextIso;
        if (cal.mode === 'month' && (ny !== cal.year || nm !== cal.month)) {
          cal.year = ny;
          cal.month = nm;
          renderOwnerAnalytics();
          return;
        }
        bodyEl.querySelectorAll('[data-ca-date]').forEach(c => c.classList.toggle('is-selected', c.dataset.caDate === cal.selectedDate));
        loadDayInspector(nextIso);
      };

      const paintDay = detail => {
        if (!slot.isConnected) return;
        const s = detail.summary || {};
        const payments = detail.payments || [];
        const walkins = detail.walkins || [];
        const sales = detail.sales || [];
        const visits = detail.visits || [];
        const expenses = detail.expenses || [];
        const newMembers = detail.new_members || [];
        const anyActivity = payments.length || walkins.length || sales.length || visits.length || expenses.length || newMembers.length;
        const revTotal = Number(s.revenue || 0);
        const mPct = revTotal > 0 ? Math.round((Number(s.membership || 0) / revTotal) * 100) : 0;
        const wPct = revTotal > 0 ? Math.round((Number(s.walkin || 0) / revTotal) * 100) : 0;
        const pPct = revTotal > 0 ? Math.max(0, 100 - mPct - wPct) : 0;
        if (!cal.dayFilter) cal.dayFilter = 'all';
        const show = k => cal.dayFilter === 'all' || cal.dayFilter === k;

        slot.innerHTML = `
          <div class="ca-day-head">
            <div><div class="staff-kicker">SELECTED DAY</div><h3 style="margin:0">${esc(fmtDay(dateStr))}</h3><p style="margin:4px 0 0;color:#8c988f;font-size:11px">${s.checkins || 0} check-ins · ${payments.length + walkins.length + sales.length} transactions</p></div>
            <div class="ca-day-steps">
              <button type="button" class="ca-step" id="ca-day-prev" title="Previous day" aria-label="Previous day">‹</button>
              <button type="button" class="ca-step" id="ca-day-next" title="Next day" aria-label="Next day">›</button>
            </div>
          </div>
          <div class="ca-day-metrics">
            <div class="ca-day-stat"><span>REVENUE</span><strong>${peso(revTotal)}</strong></div>
            <div class="ca-day-stat"><span>EXPENSES</span><strong>${peso(s.expenses || 0)}</strong></div>
            <div class="ca-day-stat"><span>NET</span><strong>${peso(s.net_profit || 0)}</strong></div>
          </div>
          ${revTotal > 0 ? `
            <div class="ca-mix-strip" aria-hidden="true">
              ${mPct ? `<i style="width:${mPct}%;background:#264631"></i>` : ''}
              ${wPct ? `<i style="width:${wPct}%;background:#78aa46"></i>` : ''}
              ${pPct ? `<i style="width:${pPct}%;background:#b8db7a"></i>` : ''}
            </div>
            <div class="ca-mix-legend">
              <span><i style="background:#264631"></i>Memberships ${peso(s.membership || 0)}</span>
              <span><i style="background:#78aa46"></i>Walk-ins ${peso(s.walkin || 0)}</span>
              <span><i style="background:#b8db7a"></i>Products ${peso(s.product || 0)}</span>
            </div>` : ''}
          ${anyActivity ? `
            <div class="ca-day-tabs">
              <button type="button" class="ca-day-tab ${cal.dayFilter === 'all' ? 'active' : ''}" data-day-tab="all">All</button>
              ${(payments.length + walkins.length + sales.length) ? `<button type="button" class="ca-day-tab ${cal.dayFilter === 'tx' ? 'active' : ''}" data-day-tab="tx">Takings (${payments.length + walkins.length + sales.length})</button>` : ''}
              ${visits.length ? `<button type="button" class="ca-day-tab ${cal.dayFilter === 'visits' ? 'active' : ''}" data-day-tab="visits">Check-ins (${visits.length})</button>` : ''}
              ${expenses.length ? `<button type="button" class="ca-day-tab ${cal.dayFilter === 'expenses' ? 'active' : ''}" data-day-tab="expenses">Expenses (${expenses.length})</button>` : ''}
            </div>` : ''}
          <div class="ca-day-scroll">
            ${!anyActivity ? '<div class="ca-day-empty"><b>Quiet day</b><span>No check-ins, sales, or expenses were recorded on this date.</span></div>' : ''}
            ${show('tx') && payments.length ? `<div class="ca-day-group"><h4>Payments (${payments.length})</h4>${payments.map(p => `<div class="ca-day-item"><div><b>${esc(p.name)}</b><small>${esc(p.receipt_no)} · ${esc(p.method)} · ${esc(p.status)}</small></div><strong>${peso(p.amount)}</strong></div>`).join('')}</div>` : ''}
            ${show('tx') && walkins.length ? `<div class="ca-day-group"><h4>Walk-ins (${walkins.length})</h4>${walkins.map(w => `<div class="ca-day-item"><div><b>${esc(w.name)}</b><small>${esc(w.receipt_no)} · ${esc(w.method)}</small></div><strong>${peso(w.amount)}</strong></div>`).join('')}</div>` : ''}
            ${show('tx') && sales.length ? `<div class="ca-day-group"><h4>Product sales (${sales.length})</h4>${sales.map(x => `<div class="ca-day-item"><div><b>${esc(x.name)}</b><small>${esc(x.receipt_no)} · ${esc(x.method)}</small></div><strong>${peso(x.total)}</strong></div>`).join('')}</div>` : ''}
            ${show('visits') && visits.length ? `<div class="ca-day-group"><h4>Check-ins (${visits.length})</h4>${visits.map(v => `<div class="ca-day-item"><div><b>${esc(v.member_name)}</b><small>${esc(v.member_no)} · in ${esc(ui.chTime(v.checked_in_at))}${v.checked_out_at ? ` · out ${esc(ui.chTime(v.checked_out_at))}` : ' · still inside'}</small></div></div>`).join('')}</div>` : ''}
            ${cal.dayFilter === 'all' && newMembers.length ? `<div class="ca-day-group"><h4>New members (${newMembers.length})</h4>${newMembers.map(m => `<div class="ca-day-item"><div><b>${esc(m.full_name)}</b><small>${esc(m.member_no)}</small></div><span class="status-tag">${esc(m.status)}</span></div>`).join('')}</div>` : ''}
            ${show('expenses') && expenses.length ? `<div class="ca-day-group"><h4>Expenses (${expenses.length})</h4>${expenses.map(e => `<div class="ca-day-item"><div><b>${esc(e.description)}</b><small>${esc(e.category)} · ${esc(e.method)}</small></div><strong>−${peso(e.amount)}</strong></div>`).join('')}</div>` : ''}
          </div>`;

        slot.querySelector('#ca-day-prev').onclick = () => stepDay(-1);
        slot.querySelector('#ca-day-next').onclick = () => stepDay(1);
        slot.querySelectorAll('[data-day-tab]').forEach(t => {
          t.onclick = () => { cal.dayFilter = t.dataset.dayTab; paintDay(detail); };
        });
      };

      const cached = dayDetailCache.get(dateStr);
      if (cached) { paintDay(cached); }
      try {
        const fresh = await call('calendar_day_detail', { p_date: dateStr });
        dayDetailCache.set(dateStr, fresh);
        paintDay(fresh);
      } catch (err) {
        if (!cached && slot.isConnected) slot.innerHTML = `<p class="sub">${esc(friendly(err))}</p>`;
      }
    };

    paintControls(baseYears);
    const cacheKey = `${range.from}:${range.to}`;
    const cachedRange = analyticsCache.get(cacheKey);
    if (cachedRange) {
      paintAnalytics(cachedRange);
    } else {
      bodyEl.innerHTML = '<div class="card"><p class="sub" style="padding:18px 0">Loading historical analytics…</p></div>';
    }

    call('calendar_analytics', { p_from: range.from, p_to: range.to })
      .then(fresh => {
        analyticsCache.set(cacheKey, fresh);
        paintAnalytics(fresh);
      })
      .catch(err => {
        if (!cachedRange && bodyEl.isConnected) {
          bodyEl.innerHTML = `<div class="card"><p class="sub">${esc(friendly(err))}</p></div>`;
        }
      });
  }


  function renderOwnerInventory() {
    const items = live.inventory;
    const low = items.filter(i => i.quantity <= i.threshold);
    const out = items.filter(i => i.quantity === 0);
    const sold = live.sales.filter(s => s.sold_on === phToday()).reduce((n, s) => n + Number(s.total), 0);
    const receipts = live.sales.filter(s => s.sold_on === phToday()).length;
    const stockValue = items.reduce((n, i) => n + Number(i.price) * Number(i.quantity), 0);
    const attention = items.filter(i => i.quantity <= i.threshold).sort((a, b) => a.quantity - b.quantity).slice(0, 5);

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">GYM OPERATIONS</div>
          <h2>Inventory</h2>
          <p>You set the products, prices and stock. Staff sell from this list.</p>
        </div>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: 'STOCK VALUE ON HAND',
          valueHtml: `<strong>${peso(stockValue)}</strong>`,
          sub: `${items.length} products tracked · ${out.length} out of stock`,
          sparkLabel: '7-DAY SALES',
          sparkPeak: `${peso(sold)} today`,
          points: lastDays(7).map(d => live.sales.filter(x => !x.voided_at && String(x.sold_on).slice(0, 10) === d.iso).reduce((n, x) => n + Number(x.total), 0)),
          split: [['PRODUCTS', items.length], ['LOW STOCK', low.length], ['OUT OF STOCK', out.length]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>PRODUCTS</small><strong>${items.length}</strong><em>tracked consumables</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>LOW STOCK</small><strong>${low.length}</strong><em>at or below threshold</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>OUT OF STOCK</small><strong>${out.length}</strong><em>restock needed</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">₱</span><div><small>SOLD TODAY</small><strong>${peso(sold)}</strong><em>${receipts} receipts</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card owner-directory">
          <div class="panel-head"><div><div class="staff-kicker">CONSUMABLE PRODUCTS</div><h3>Stock and prices</h3><p>Only you can change products or pricing.</p></div><div style="display:flex;gap:8px"><button class="outline" id="stock-take-btn" style="height:38px">Stock-take</button><button class="login-submit" id="product-new" style="width:auto;height:38px;padding:0 16px">+ Add product</button></div></div>
          <div id="product-form-slot"></div>
          <div class="inventory-list">${items.map(item => `<div class="inventory-row"><span class="inventory-icon">${productIcon(item.name)}</span><div><strong>${esc(item.name)}</strong><small>${peso(item.price)} each${Number(item.cost) > 0 ? ` · costs ${peso(item.cost)}` : ''} · low-stock at ${item.threshold} ${esc(item.unit)}${item.supplier ? ` · ${esc(item.supplier)}` : ''}</small></div><span class="inventory-quantity-label"><b>${item.quantity}</b> ${esc(item.unit)}</span><span class="status-tag ${item.quantity === 0 ? 'status-deactivated' : item.quantity <= item.threshold ? 'status-expiring' : ''}">${item.quantity === 0 ? 'Out of stock' : item.quantity <= item.threshold ? 'Low stock' : 'In stock'}</span><div class="inventory-actions"><button class="outline restock-item" data-id="${item.id}">Restock</button><button class="outline stock-edit" data-id="${item.id}">Adjust</button><button class="outline price-edit" data-id="${item.id}">Price</button></div></div>`).join('') || '<p class="sub">No products yet. Add your first product.</p>'}</div>
        </section>

        <div class="rp-side-stack">
          <section class="card rp-new-card">
            <div class="panel-head"><div><div class="staff-kicker">NEEDS ATTENTION</div><h3>Low stock</h3><p>Products closest to running out.</p></div><span class="rp-pill">${low.length} low</span></div>
            ${attention.length ? attention.map(i => `<div class="rp-new-row"><span class="inventory-icon">${productIcon(i.name)}</span><div><strong>${esc(i.name)}</strong><small>${peso(i.price)} each · ${esc(i.unit)}</small></div><span class="status-tag ${i.quantity === 0 ? 'status-deactivated' : 'status-expiring'}">${i.quantity} left</span></div>`).join('') : '<p class="sub">Nothing is running low. Stock levels look healthy.</p>'}
          </section>
          <section class="card page-panel">
            <div class="panel-head"><div><div class="staff-kicker">STOCK MOVEMENTS</div><h3>Recent activity</h3><p>Every adjustment and sale is logged.</p></div></div>
            ${live.movements?.length ? live.movements.slice(0, 8).map(m => `<div class="attention-row"><div><strong>${esc(m.reason)}</strong><small>${esc(phDateTime(m.created_at))}</small></div><span>${m.delta > 0 ? '+' : ''}${m.delta}</span></div>`).join('') : '<p class="sub" style="padding:10px 0">Movement history is recorded as products are added and sold.</p>'}
          </section>
        </div>
      </div>`;
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
    const who = currentIdentity();
    const rawName = (live.profile?.full_name || who.label || '').trim();
    const nameParts = rawName.split(/\s+/).filter(Boolean);
    const curFirst = nameParts.length ? nameParts[0] : '';
    const curLast = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    ownerContent.innerHTML = `
      <div class="rp-head"><div><div class="eyebrow" style="color:#8ba284">YOUR GYM, YOUR SETTINGS</div><h2>Settings</h2><p>Owner profile, account password, gym details, and membership pricing.</p></div></div>
      <div class="settings-grid">
        <div class="settings-col">
          <section class="card settings-card">
            <div class="panel-head"><div><div class="staff-kicker">OWNER PROFILE</div><h3>Your account</h3><p>Your last name appears in the dashboard greeting and your initials appear on your profile badge.</p></div><span class="owner-panel-icon">♙</span></div>
            <div class="owner-settings-profile-banner">
              <span class="owner-settings-avatar" id="owner-preview-avatar">${esc(who.ini)}</span>
              <div>
                <strong id="owner-preview-name">${esc(who.label)}</strong>
                <small id="owner-preview-greeting">Greeting: “Good day, ${esc(who.last)}.” · ${esc(who.email || '')}</small>
              </div>
            </div>
            <form id="owner-profile-form">
              <div class="modal-two-col">
                <div><label class="field" for="owner-first-name">First name</label><input class="login-input" id="owner-first-name" maxlength="60" value="${esc(curFirst)}" placeholder="e.g. Thomas" required></div>
                <div><label class="field" for="owner-last-name">Last name</label><input class="login-input" id="owner-last-name" maxlength="60" value="${esc(curLast)}" placeholder="e.g. Hizon" required></div>
              </div>
              <label class="field" for="owner-account-email">Signed-in email</label>
              <input class="login-input" id="owner-account-email" value="${esc(who.email || '')}" disabled style="background:#f5f7f3;color:#738376">
              <div class="settings-save-line"><p>Changes update your greeting and profile initials everywhere.</p><button type="submit" class="login-submit" id="save-owner-profile">Save profile ↗</button></div>
            </form>
          </section>

          <section class="card settings-card">
            <div class="panel-head"><div><div class="staff-kicker">ACCOUNT SECURITY</div><h3>Change password</h3><p>Update the password you use to sign in to the owner dashboard.</p></div><span class="owner-panel-icon">✳</span></div>
            <form id="owner-password-form">
              <label class="field" for="owner-new-pw">New password</label>
              <div class="input-box">
                <input class="login-input" id="owner-new-pw" type="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required>
                <button type="button" class="password-toggle" id="owner-pw-toggle">Show</button>
              </div>
              <label class="field" for="owner-confirm-pw">Confirm new password</label>
              <input class="login-input" id="owner-confirm-pw" type="password" minlength="8" autocomplete="new-password" placeholder="Re-enter your new password" required>
              <div class="settings-save-line"><p>Minimum 8 characters. Takes effect right away.</p><button type="submit" class="outline" id="save-owner-pw">Update password</button></div>
            </form>
          </section>
        </div>

        <div class="settings-col">
          <section class="card settings-card">
            <div class="panel-head"><div><div class="staff-kicker">MEMBERSHIP PLANS</div><h3>Set your pricing</h3><p>Prices prefill staff renewals. Amounts are in Philippine pesos.</p></div><span class="owner-panel-icon">₱</span></div>
            <form id="live-plans-form">
              <div class="plan-grid">${live.plans.map((p, i) => `<label class="plan-tile"><span class="plan-tile-top"><span class="plan-symbol">${['◷', '↗', '✳', '◌'][i % 4]}</span><span class="plan-period">${p.months === 12 ? 'ANNUAL' : 'MONTHLY'}</span></span><strong>${esc(p.label)}</strong><small>Membership plan</small><span class="plan-price-wrap"><span>₱</span><input class="plan-price" data-months="${p.months}" type="number" min="0" step="0.01" value="${Number(p.price || 0)}" required></span></label>`).join('')}</div>
              <div class="walkin-setting"><span class="plan-symbol">↗</span><div><strong>Walk-in fee</strong><small>Charged separately from memberships</small></div><label class="plan-price-wrap"><span>₱</span><input id="live-walkin" type="number" min="0" step="0.01" value="${setting.walkin_fee ?? ''}" placeholder="Not set"></label></div>
              <div class="settings-save-line"><p id="settings-note">Saved pricing applies to every staff account.</p><button type="submit" class="login-submit">Save pricing ↗</button></div>
            </form>
          </section>

          <section class="card settings-card">
            <div class="panel-head"><div><div class="staff-kicker">GYM INFORMATION</div><h3>Branch details</h3><p>Basic gym name and location shown across your workspace.</p></div><span class="owner-panel-icon">▤</span></div>
            <form id="gym-info-form">
              <label class="field" for="gym-display-name">Gym name</label>
              <input class="login-input" id="gym-display-name" maxlength="80" value="${esc(setting.gym_name || 'Hill Fitness Gym')}" placeholder="Hill Fitness Gym" required>
              <label class="field" for="gym-branch-address">Branch address</label>
              <input class="login-input" id="gym-branch-address" maxlength="160" value="${esc(setting.business_address || '')}" placeholder="e.g. Pasig City">
              <div class="settings-save-line"><p>Updates your gym name in the header.</p><button type="submit" class="outline" id="save-gym-info">Save gym details</button></div>
            </form>
          </section>
        </div>
      </div>`;

    const firstInput = ownerContent.querySelector('#owner-first-name');
    const lastInput = ownerContent.querySelector('#owner-last-name');
    const previewAvatar = ownerContent.querySelector('#owner-preview-avatar');
    const previewName = ownerContent.querySelector('#owner-preview-name');
    const previewGreeting = ownerContent.querySelector('#owner-preview-greeting');
    const syncPreview = () => {
      const f = firstInput.value.trim();
      const l = lastInput.value.trim();
      const combined = [f, l].filter(Boolean).join(' ') || who.email || 'Account';
      const parts = combined.split(/\s+/).filter(Boolean);
      const lastWord = parts.length > 1 ? parts[parts.length - 1] : (parts[0] || 'there');
      const ini = parts.length > 1
        ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
        : (parts[0]?.[0] || '?').toUpperCase();
      if (previewAvatar) previewAvatar.textContent = ini;
      if (previewName) previewName.textContent = combined;
      if (previewGreeting) previewGreeting.textContent = `Greeting: “Good day, ${lastWord}.” · ${who.email || ''}`;
    };
    firstInput?.addEventListener('input', syncPreview);
    lastInput?.addEventListener('input', syncPreview);

    ownerContent.querySelector('#owner-profile-form').onsubmit = async event => {
      event.preventDefault();
      const f = firstInput.value.trim();
      const l = lastInput.value.trim();
      if (!f || !l) return toastLive('Please enter both first name and last name.');
      const fullName = `${f} ${l}`.replace(/\s+/g, ' ').trim();
      const saveBtn = ownerContent.querySelector('#save-owner-profile');
      saveBtn.disabled = true;
      const prevText = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        const { error: profErr } = await sb.from('profiles').update({ full_name: fullName }).eq('id', live.profile.id);
        if (profErr) throw profErr;
        try { await sb.auth.updateUser({ data: { full_name: fullName } }); } catch (_) { /* optional metadata sync */ }
        live.profile = { ...live.profile, full_name: fullName };
        if (live.session?.user) {
          live.session.user.user_metadata = { ...(live.session.user.user_metadata || {}), full_name: fullName };
        }
        paintGreeting();
        toastLive('Owner profile updated.');
        await refreshData(true);
        renderOwnerSettings();
      } catch (error) {
        toastLive(friendly(error));
        saveBtn.disabled = false;
        saveBtn.textContent = prevText;
      }
    };

    const pwToggle = ownerContent.querySelector('#owner-pw-toggle');
    const pwNew = ownerContent.querySelector('#owner-new-pw');
    const pwConfirm = ownerContent.querySelector('#owner-confirm-pw');
    if (pwToggle && pwNew) {
      pwToggle.onclick = () => {
        const show = pwNew.type === 'password';
        pwNew.type = show ? 'text' : 'password';
        if (pwConfirm) pwConfirm.type = show ? 'text' : 'password';
        pwToggle.textContent = show ? 'Hide' : 'Show';
      };
    }

    ownerContent.querySelector('#owner-password-form').onsubmit = async event => {
      event.preventDefault();
      const p1 = pwNew.value;
      const p2 = pwConfirm.value;
      if (p1.length < 8) return toastLive('Password must be at least 8 characters.');
      if (p1 !== p2) return toastLive('Passwords do not match.');
      const btn = ownerContent.querySelector('#save-owner-pw');
      btn.disabled = true;
      const prev = btn.textContent;
      btn.textContent = 'Updating…';
      try {
        const { error } = await sb.auth.updateUser({ password: p1 });
        if (error) throw error;
        pwNew.value = '';
        pwConfirm.value = '';
        toastLive('Your password has been updated.');
      } catch (error) {
        toastLive(friendly(error));
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
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

    ownerContent.querySelector('#gym-info-form').onsubmit = async event => {
      event.preventDefault();
      const gymName = ownerContent.querySelector('#gym-display-name').value.trim();
      const address = ownerContent.querySelector('#gym-branch-address').value.trim() || null;
      if (!gymName) return toastLive('Gym name is required.');
      try {
        const { error } = await sb.from('gym_settings').update({ gym_name: gymName, business_address: address }).eq('id', true);
        if (error) throw error;
        live.settings = { ...(live.settings || {}), gym_name: gymName, business_address: address };
        paintGreeting();
        toastLive('Gym details saved.');
        await refreshData(true);
        renderOwnerSettings();
      } catch (error) { toastLive(friendly(error)); }
    };
  }

  /* Staff views ----------------------------------------------------------- */
  const staffNav = staffShell.querySelector('.nav');

  function refreshStaff(tab, animate = true) {
    const active = staffNav.querySelector('button.active');
    const view = tab || active?.dataset.staffTab || 'overview';
    if (view === 'members') renderStaffMembers();
    else if (view === 'checkins' || view === 'walkins') renderStaffCheckins();
    else if (view === 'inventory') renderStaffInventory();
    else renderStaffOverview();
    revealNavigation(staffNav);
    if (animate) revealDashboard(staffContent);
  }

  function staffHeading(kicker, title, sub, rightHtml = '') {
    return `<div class="rp-head"><div><div class="eyebrow" style="color:#8ba284">${kicker}</div><h2>${title}</h2><p>${sub}</p></div>${rightHtml ? `<div>${rightHtml}</div>` : ''}</div>`;
  }

  function renderStaffOverview() {
    const s = summary();
    const today = phToday();
    const todayVisits = live.visits.filter(v => v.visit_date === today);
    const uniqueCheckins = new Set(todayVisits.map(v => v.member_id)).size;
    const open = live.visits.filter(v => !v.checked_out_at);
    const todayPay = live.payments.filter(p => !p.voided_at && String(p.paid_on).slice(0, 10) === today).reduce((n, p) => n + Number(p.amount || 0), 0);
    const todayProd = live.sales.filter(s2 => !s2.voided_at && String(s2.sold_on).slice(0, 10) === today).reduce((n, s2) => n + Number(s2.total || 0), 0);
    const todayWalk = live.walkins.filter(w => !w.voided_at && String(w.visited_on).slice(0, 10) === today).reduce((n, w) => n + Number(w.amount || 0), 0);
    const todaySales = todayPay + todayProd + todayWalk;
    const pendingPayCount = live.payments.filter(p => p.status === 'pending').length;
    const pendingApprovalCount = (live.approvals || []).filter(a => a.status === 'pending').length;
    const pendingCount = pendingPayCount + pendingApprovalCount;
    const days7 = lastDays(7);
    const rev7 = days7.map(d =>
      live.payments.filter(p => !p.voided_at && String(p.paid_on).slice(0, 10) === d.iso).reduce((n, p) => n + Number(p.amount || 0), 0)
      + live.walkins.filter(w => !w.voided_at && String(w.visited_on).slice(0, 10) === d.iso).reduce((n, w) => n + Number(w.amount || 0), 0)
      + live.sales.filter(x => !x.voided_at && String(x.sold_on).slice(0, 10) === d.iso).reduce((n, x) => n + Number(x.total || 0), 0)
    );
    const peak7 = Math.max(0, ...rev7);
    const firstName = (live.profile.full_name || (live.profile.email || '').split('@')[0] || 'there').trim().split(' ')[0];
    staffShell.querySelector('.intro h1').innerHTML = `Good day, <em>${esc(firstName)}.</em>`;
    staffShell.querySelector('.avatar').textContent = currentIdentity().ini;
    staffShell.querySelector('.avatar').title = currentIdentity().label;
    const attention = live.members.filter(m => m.expiring_soon || (m.expired && m.status === 'Active')).slice(0, 6);
    if (!live.staffActDate || live.staffActDayAnchor !== today) {
      live.staffActDate = today;
      live.staffActDayAnchor = today;
      live.staffActPage = 1;
    }

    staffContent.innerHTML = `
      ${staffHeading('YOUR DAY AT HILL', 'Operations overview', 'A live picture of what needs attention today.')}
      <div class="rp-top">
        ${bentoHero({
          label: 'TODAY’S FRONT-DESK SALES',
          valueHtml: `<strong>${peso(todaySales)}</strong>`,
          sub: `${peso(todayPay)} memberships · ${peso(todayProd)} shop · ${peso(todayWalk)} walk-ins`,
          sparkLabel: '7-DAY PULSE',
          sparkPeak: `Peak ${peso(peak7)}`,
          points: rev7,
          split: [['ACTIVE MEMBERS', s.active], ['CHECK-INS TODAY', uniqueCheckins], ['PENDING PAYMENTS', pendingCount]]
        })}
        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>ACTIVE MEMBERS</small><strong>${s.active}</strong><em>${s.expiring || 0} expiring soon</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">↗</span><div><small>CHECK-INS TODAY</small><strong>${uniqueCheckins}</strong><em>${open.length} still checked in</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>OPEN VISITS</small><strong>${open.length}</strong><em>inside without exit</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">₱</span><div><small>PENDING REVIEW</small><strong>${pendingCount}</strong><em>waiting for owner</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card staff-panel">
          <div class="panel-head"><div><div class="staff-kicker">FRONT DESK</div><h3>Quick member lookup</h3><p>Find a member to check in, view photo, or renew.</p></div></div>
          <input class="login-input" id="quick" placeholder="Search name, ID or phone" aria-label="Search members">
          <div id="quick-results" class="quick-results" style="margin-top:10px"><p class="sub">Start typing to search members.</p></div>
        </section>
        <section class="card staff-panel">
          <div class="panel-head"><div><div class="staff-kicker">NEEDS ATTENTION</div><h3>Memberships</h3><p>Expired or expiring within 7 days.</p></div></div>
          ${attention.length ? attention.map(m => `<div class="staff-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag status-expiring">Expiring</span><button class="outline staff-renew" data-id="${m.id}">Renew ↗</button></div>`).join('') : '<p class="sub">No memberships need attention.</p>'}
        </section>
      </div>

      <section class="staff-table-card" id="staff-daily-activity">
        <div class="panel-head" style="flex-wrap:wrap;gap:12px">
          <div>
            <div class="staff-kicker" id="staff-act-kicker">${live.staffActDate === today ? 'TODAY’S ACTIVITY' : 'DAILY ACTIVITY'}</div>
            <h3>What your team recorded</h3>
            <p id="staff-act-sub">Showing ${esc(fmtDay(live.staffActDate))} · Philippine time.</p>
          </div>
          <div class="daily-log-controls">
            <button type="button" class="ca-step" id="staff-act-prev" title="Previous day" aria-label="Previous day">‹</button>
            <input type="date" class="ca-date-input" id="staff-act-date" value="${esc(live.staffActDate)}" max="${today}" aria-label="Activity date">
            <button type="button" class="ca-step" id="staff-act-next" title="Next day" aria-label="Next day" ${live.staffActDate >= today ? 'disabled' : ''}>›</button>
            <button type="button" class="outline" id="staff-act-today" ${live.staffActDate === today ? 'disabled' : ''}>Today</button>
          </div>
        </div>
        <div id="staff-act-list"></div>
        <div id="staff-act-pager"></div>
      </section>`;

    const phDayOf = ts => ts ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts)) : '';
    const shiftIso = (iso, delta) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
    };
    const staffActCache = new Map();
    const PAGE_SIZE = 6;

    const paintActivityDay = rows => {
      const listEl = staffContent.querySelector('#staff-act-list');
      const pagerEl = staffContent.querySelector('#staff-act-pager');
      const subEl = staffContent.querySelector('#staff-act-sub');
      const kickerEl = staffContent.querySelector('#staff-act-kicker');
      if (!listEl || !listEl.isConnected) return;
      const dStr = live.staffActDate;
      if (kickerEl) kickerEl.textContent = dStr === today ? 'TODAY’S ACTIVITY' : 'PAST ACTIVITY';
      if (subEl) subEl.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'} on ${fmtDay(dStr)} · Philippine time.`;
      if (!rows.length) {
        listEl.innerHTML = `<p class="sub" style="padding:12px 0">No activity recorded on ${esc(fmtDay(dStr))}.</p>`;
        if (pagerEl) pagerEl.innerHTML = '';
        return;
      }
      const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
      if (live.staffActPage > totalPages) live.staffActPage = totalPages;
      const page = live.staffActPage;
      const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
      listEl.innerHTML = slice.map(a => `<div class="attention-row"><div><strong>${esc(a.summary)}</strong><small>${esc(a.actor_name || 'Gym')} · ${esc(phDateTime(a.created_at))}</small></div></div>`).join('');

      if (!pagerEl) return;
      if (totalPages <= 1) { pagerEl.innerHTML = ''; return; }
      const pages = Array.from({ length: totalPages }, (_, i) => i + 1)
        .filter(n => n === 1 || n === totalPages || Math.abs(n - page) <= 1);
      let nums = '';
      let prev = 0;
      for (const n of pages) {
        if (prev && n - prev > 1) nums += '<span class="owner-pager-gap">…</span>';
        nums += `<button type="button" class="owner-page-num ${n === page ? 'is-current' : ''}" data-ap="${n}">${n}</button>`;
        prev = n;
      }
      pagerEl.innerHTML = `<div class="owner-pager"><span class="owner-pager-count">Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, rows.length)} of ${rows.length}</span><div class="owner-pager-buttons"><button type="button" class="outline" id="ap-prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button><div class="owner-pager-pages">${nums}</div><button type="button" class="outline" id="ap-next" ${page >= totalPages ? 'disabled' : ''}>Next ›</button></div></div>`;
      pagerEl.querySelector('#ap-prev')?.addEventListener('click', () => { live.staffActPage -= 1; paintActivityDay(rows); });
      pagerEl.querySelector('#ap-next')?.addEventListener('click', () => { live.staffActPage += 1; paintActivityDay(rows); });
      pagerEl.querySelectorAll('[data-ap]').forEach(btn => btn.onclick = () => { live.staffActPage = Number(btn.dataset.ap); paintActivityDay(rows); });
    };

    const loadActivityDay = async () => {
      const dStr = live.staffActDate;
      const dateInput = staffContent.querySelector('#staff-act-date');
      const prevBtn = staffContent.querySelector('#staff-act-prev');
      const nextBtn = staffContent.querySelector('#staff-act-next');
      const todayBtn = staffContent.querySelector('#staff-act-today');
      if (dateInput) dateInput.value = dStr;
      if (nextBtn) nextBtn.disabled = dStr >= today;
      if (todayBtn) todayBtn.disabled = dStr === today;

      const localMatches = live.activity.filter(a => phDayOf(a.created_at) === dStr);
      paintActivityDay(staffActCache.get(dStr) || localMatches);
      try {
        const { data, error } = await sb
          .from('activity_log')
          .select('*')
          .gte('created_at', `${dStr}T00:00:00+08:00`)
          .lte('created_at', `${dStr}T23:59:59.999+08:00`)
          .order('created_at', { ascending: false })
          .limit(200);
        if (!error && Array.isArray(data)) {
          const rows = data.length || dStr !== today ? data : localMatches;
          staffActCache.set(dStr, rows);
          paintActivityDay(rows);
        }
      } catch { /* fallback to localMatches */ }
      if (prevBtn) prevBtn.onclick = () => { live.staffActDate = shiftIso(live.staffActDate, -1); live.staffActPage = 1; loadActivityDay(); };
      if (nextBtn) nextBtn.onclick = () => { const n = shiftIso(live.staffActDate, 1); live.staffActDate = n > today ? today : n; live.staffActPage = 1; loadActivityDay(); };
      if (todayBtn) todayBtn.onclick = () => { live.staffActDate = today; live.staffActPage = 1; loadActivityDay(); };
      if (dateInput) dateInput.onchange = () => { if (dateInput.value) { live.staffActDate = dateInput.value > today ? today : dateInput.value; live.staffActPage = 1; loadActivityDay(); } };
    };
    loadActivityDay();

    const input = staffContent.querySelector('#quick');
    const results = staffContent.querySelector('#quick-results');
    input.oninput = () => {
      const q = input.value.trim().toLowerCase();
      if (!q) { results.innerHTML = '<p class="sub">Start typing to search members.</p>'; return; }
      const matches = live.members.filter(m => [m.full_name, m.member_no, m.phone].join(' ').toLowerCase().includes(q)).slice(0, 6);
      results.innerHTML = matches.map(m => `<div class="staff-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'No plan')} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag ${m.effective_status === 'Active' ? '' : 'status-deactivated'}">${m.effective_status}</span><button class="outline quick-open" data-id="${m.id}">Open ↗</button></div>`).join('') || '<p class="sub">No members found.</p>';
      results.querySelectorAll('.quick-open').forEach(button => button.onclick = () => openStaffMember(button.dataset.id));
    };
    staffContent.querySelectorAll('.staff-renew').forEach(button => button.onclick = () => openRenewalLive(button.dataset.id));
  }

  function renderStaffMembers() {
    const all = live.members.length;
    const active = live.members.filter(m => m.effective_status === 'Active').length;
    const expiring = live.members.filter(m => m.expiring_soon).length;
    const deactivated = live.members.filter(m => m.effective_status === 'Deactivated').length;
    const share = all ? Math.round((active / all) * 100) : 0;
    const days7 = lastDays(7);
    const signups7 = days7.map(d => live.members.filter(m => String(m.joined_on).slice(0, 10) === d.iso).length);

    staffContent.innerHTML = `
      ${staffHeading('YOUR COMMUNITY', 'Member directory', 'Find members, update photos, review status and request profile changes.')}
      <div class="rp-top">
        ${bentoHero({
          label: 'TOTAL MEMBERS',
          valueHtml: `<strong>${all}</strong>`,
          sub: `${active} active · ${deactivated} deactivated`,
          sparkLabel: '7-DAY SIGN-UPS',
          sparkPeak: `${signups7.reduce((n, x) => n + x, 0)} this week`,
          points: signups7,
          split: [['ACTIVE', active], ['EXPIRING SOON', expiring], ['DEACTIVATED', deactivated]]
        })}
        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>ACTIVE MEMBERS</small><strong>${active}</strong><em>can check in today</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>EXPIRING SOON</small><strong>${expiring}</strong><em>within 7 days</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>DEACTIVATED</small><strong>${deactivated}</strong><em>expired or turned off</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">↗</span><div><small>ACTIVE SHARE</small><strong>${share}%</strong><em>of all members</em></div></article>
        </div>
      </div>
      <div class="staff-search-bar"><input class="login-input" id="staff-search" placeholder="Search members by name, ID or phone"><button class="login-submit" id="staff-add" style="width:auto;white-space:nowrap;padding:0 20px">+ Add member</button></div>
      <div id="staff-form-slot"></div>
      <div id="staff-list"></div>`;
    const list = staffContent.querySelector('#staff-list');
    const search = staffContent.querySelector('#staff-search');
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const rows = live.members.filter(m => [m.full_name, m.member_no, m.phone, m.email].join(' ').toLowerCase().includes(q));
      if (!rows.length) {
        list.innerHTML = `<section class="staff-table-card page-panel"><div class="panel-head"><div><h3>All members</h3><p>No members yet.</p></div></div><div class="attendance-empty" style="line-height:1.9">Your member list is empty. Use <strong>+ Add member</strong> above to register the first member — a member ID, expiry date and receipt are created automatically.</div></section>`;
        return;
      }
      list.innerHTML = `<section class="staff-table-card page-panel"><div class="panel-head"><div><div class="staff-kicker">DIRECTORY</div><h3>All members</h3><p>${rows.length} member${rows.length === 1 ? '' : 's'} · newest first.</p></div></div>${rows.map(m => `<div class="staff-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)} · ${esc(m.plan_months ? planLabel(m.plan_months) : 'No plan')} · expires ${esc(fmtDay(m.expires_on))}</small></div><span class="status-tag ${m.effective_status === 'Deactivated' ? 'status-deactivated' : m.expiring_soon ? 'status-expiring' : ''}">${m.effective_status === 'Deactivated' && m.expired ? 'Expired' : m.effective_status}</span><button class="outline staff-open" data-id="${m.id}">Open ↗</button></div>`).join('')}</section>`;
      list.querySelectorAll('.staff-open').forEach(button => button.onclick = () => openStaffMember(button.dataset.id));
    };
    search.oninput = draw;
    draw();
    staffContent.querySelector('#staff-add').onclick = () => addMemberLive(() => renderStaffMembers());
  }

  function openStaffMember(id) {
    openMemberProfileModal(id);
  }

  function addMemberLive(onDone) {
    const prices = Object.fromEntries(live.plans.map(p => [p.months, Number(p.price || 0)]));
    const box = document.createElement('dialog');
    box.className = 'renew-dialog add-member-dialog';
    box.id = 'add-member-dialog';
    box.innerHTML = `<form class="renew-inner" id="add-member-form" novalidate>
      <div class="renew-header">
        <div>
          <div class="eyebrow" style="color:#87a278">NEW MEMBER</div>
          <h2>Add a member</h2>
          <p>Fields marked <span class="req-star">*</span> are required. Creates the member, records payment, and sets up their portal password.</p>
        </div>
        <button type="button" class="renew-close" aria-label="Close">×</button>
      </div>

      <div class="add-photo-row">
        <div class="add-photo-preview" id="m-photo-preview"><span>+</span></div>
        <div class="add-photo-meta">
          <div class="add-photo-title">Member photo <span class="opt-badge">Optional</span></div>
          <div class="add-photo-controls">
            <label class="outline photo-upload" style="cursor:pointer" for="m-photo-file">Upload photo</label>
            <input type="file" id="m-photo-file" accept="image/jpeg,image/png,image/webp" hidden>
            <button type="button" class="outline" id="m-photo-remove" hidden>Remove</button>
          </div>
          <small>JPG, PNG or WebP up to 2 MB · uploaded automatically when created.</small>
        </div>
      </div>

      <div class="modal-two-col">
        <div>
          <label class="field" for="m-name">Full name<span class="req-star">*</span></label>
          <input class="login-input" id="m-name" required maxlength="100" placeholder="Member’s full name">
        </div>
        <div>
          <label class="field" for="m-phone">Mobile number<span class="req-star">*</span></label>
          <input class="login-input" id="m-phone" type="tel" required maxlength="30" placeholder="09XX XXX XXXX">
        </div>
      </div>

      <div class="modal-two-col">
        <div>
          <label class="field" for="m-email">Email address<span class="req-star">*</span></label>
          <input class="login-input" id="m-email" type="email" required placeholder="member@email.com">
        </div>
        <div>
          <label class="field" for="m-password">Portal password<span class="req-star">*</span></label>
          <div class="input-box">
            <input class="login-input" id="m-password" type="password" required minlength="8" autocomplete="new-password" placeholder="Min. 8 characters" style="padding-right:54px">
            <button type="button" class="password-toggle" id="m-pw-toggle" aria-pressed="false" style="font-size:11px;color:#5e7459;width:auto;padding:0 8px">Show</button>
          </div>
        </div>
      </div>

      <div class="modal-two-col">
        <div>
          <label class="field" for="m-plan">Membership plan<span class="req-star">*</span></label>
          <select class="login-input" id="m-plan" required>${live.plans.map(p => `<option value="${p.months}" ${p.months === 3 ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
        </div>
        <div>
          <label class="field" for="m-start">Start date<span class="req-star">*</span></label>
          <input class="login-input" id="m-start" type="date" value="${phToday()}" max="${phToday()}" required>
        </div>
      </div>

      <div class="modal-two-col">
        <div>
          <label class="field" for="m-amount">Amount paid (₱)<span class="req-star">*</span></label>
          <input class="login-input" id="m-amount" type="number" min="0" step="0.01" required value="${prices[3] ?? ''}">
        </div>
        <div>
          <label class="field" for="m-method">Payment method<span class="req-star">*</span></label>
          <select class="login-input" id="m-method" required><option value="Cash">Cash</option><option value="GCash">GCash</option><option value="Bank transfer">Bank transfer</option><option value="E-wallet">E-wallet</option><option value="Other">Other</option></select>
        </div>
      </div>

      <div id="m-ref-wrap" hidden>
        <label class="field" for="m-reference">Online transaction reference<span class="req-star">*</span></label>
        <input class="login-input" id="m-reference" maxlength="100" placeholder="Enter transfer / GCash reference">
        <p class="sub">Check the gym’s account independently. Online payments stay pending until verified.</p>
      </div>

      <div class="modal-two-col">
        <div>
          <label class="field" for="m-address">Address</label>
          <input class="login-input" id="m-address" maxlength="200" placeholder="Optional">
        </div>
        <div>
          <label class="field" for="m-emergency">Emergency contact</label>
          <input class="login-input" id="m-emergency" maxlength="100" placeholder="Name &amp; number (optional)">
        </div>
      </div>

      <p class="sub" id="m-form-error" role="status" style="color:#b44b4b;margin:12px 0 0;min-height:16px"></p>
      <p class="renew-hint">A unique member ID (HFG-XXXXXX) is assigned automatically.</p>
      <div class="renew-actions">
        <button type="button" class="outline cancel-add">Cancel</button>
        <button type="submit" class="login-submit" id="m-submit">Create member ↗</button>
      </div>
    </form>`;

    document.body.append(box);
    let chosenPhoto = null;
    let previewUrl = '';
    const revokePreview = () => { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = ''; } };
    const close = () => { revokePreview(); box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('.cancel-add').onclick = close;
    box.addEventListener('cancel', e => { e.preventDefault(); close(); });

    const photoPreview = box.querySelector('#m-photo-preview');
    const photoInput = box.querySelector('#m-photo-file');
    const photoRemove = box.querySelector('#m-photo-remove');
    const photoLabel = box.querySelector('.photo-upload');
    const nameInput = box.querySelector('#m-name');
    const syncInitialPreview = () => {
      if (chosenPhoto) return;
      const typed = nameInput.value.trim();
      photoPreview.innerHTML = `<span>${typed ? esc(initials(typed)) : '+'}</span>`;
    };
    nameInput.addEventListener('input', syncInitialPreview);

    photoInput.onchange = async () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      try { await validateImage(file); }
      catch (invalidFile) {
        photoInput.value = '';
        return toastLive(invalidFile.message);
      }
      revokePreview();
      chosenPhoto = file;
      previewUrl = URL.createObjectURL(file);
      photoPreview.innerHTML = `<img src="${esc(previewUrl)}" alt="Preview">`;
      photoLabel.textContent = 'Change photo';
      photoRemove.hidden = false;
    };
    photoRemove.onclick = () => {
      chosenPhoto = null;
      revokePreview();
      photoInput.value = '';
      photoLabel.textContent = 'Upload photo';
      photoRemove.hidden = true;
      syncInitialPreview();
    };

    const errEl = box.querySelector('#m-form-error');
    const pwInput = box.querySelector('#m-password');
    const pwToggle = box.querySelector('#m-pw-toggle');
    pwToggle.onclick = () => {
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      pwToggle.textContent = show ? 'Hide' : 'Show';
      pwToggle.setAttribute('aria-pressed', String(show));
      pwInput.focus();
    };

    box.querySelector('#m-plan').onchange = event => { box.querySelector('#m-amount').value = prices[event.target.value] ?? ''; };
    box.querySelector('#m-method').onchange = event => {
      const online = event.target.value !== 'Cash';
      box.querySelector('#m-ref-wrap').hidden = !online;
      box.querySelector('#m-reference').required = online;
    };

    box.querySelector('#add-member-form').onsubmit = async event => {
      event.preventDefault();
      errEl.textContent = '';
      const name = nameInput.value.trim();
      const phone = box.querySelector('#m-phone').value.trim();
      const email = box.querySelector('#m-email').value.trim().toLowerCase();
      const password = pwInput.value;
      const plan = Number(box.querySelector('#m-plan').value);
      const start = box.querySelector('#m-start').value;
      const amountRaw = box.querySelector('#m-amount').value;
      const amount = Number(amountRaw);
      const method = box.querySelector('#m-method').value;
      const reference = box.querySelector('#m-reference').value.trim();
      const address = box.querySelector('#m-address').value.trim();
      const emergency = box.querySelector('#m-emergency').value.trim();

      if (!name) { errEl.textContent = 'Full name is required.'; nameInput.focus(); return; }
      if (!phone) { errEl.textContent = 'Mobile number is required.'; box.querySelector('#m-phone').focus(); return; }
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Enter a valid email address.'; box.querySelector('#m-email').focus(); return; }
      if (!password || password.length < 8) { errEl.textContent = 'Password is required (minimum 8 characters).'; pwInput.focus(); return; }
      if (!start) { errEl.textContent = 'Start date is required.'; box.querySelector('#m-start').focus(); return; }
      if (amountRaw === '' || !Number.isFinite(amount) || amount < 0) { errEl.textContent = 'Enter a valid amount paid.'; box.querySelector('#m-amount').focus(); return; }
      if (method !== 'Cash' && !reference) { errEl.textContent = 'Online transaction reference is required.'; box.querySelector('#m-reference').focus(); return; }
      if (live.members.some(m => (m.email || '').toLowerCase() === email)) { errEl.textContent = 'A member with this email already exists.'; box.querySelector('#m-email').focus(); return; }

      const submitBtn = box.querySelector('#m-submit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating…';
      try {
        const created = await ui.call('create_member', {
          p_full_name: name,
          p_phone: phone,
          p_email: email,
          p_address: address || null,
          p_emergency_contact: emergency || null,
          p_plan_months: plan,
          p_starts_on: start
        });
        await ui.call('record_membership_payment', {
          p_member_id: created.id,
          p_plan_months: plan,
          p_amount: amount,
          p_method: method,
          p_reference: reference || null,
          p_paid_on: start,
          p_description: method === 'Cash' ? 'New membership' : 'New membership · online payment'
        });
        let photoNote = '';
        if (chosenPhoto) {
          try {
            const ext = chosenPhoto.type === 'image/png' ? 'png' : chosenPhoto.type === 'image/webp' ? 'webp' : 'jpg';
            const path = `${created.id}/${Date.now()}.${ext}`;
            const upload = await sb.storage.from('member-photos').upload(path, chosenPhoto, { upsert: true, contentType: chosenPhoto.type });
            if (upload.error) throw upload.error;
            const { data: pub } = sb.storage.from('member-photos').getPublicUrl(path);
            const res = await sb.from('members').update({ photo_url: pub.publicUrl }).eq('id', created.id);
            if (res.error) throw res.error;
            photoNote = ' · photo uploaded';
          } catch (photoErr) {
            photoNote = ' · photo failed (can upload from profile)';
          }
        }
        const loginRes = await sb.functions.invoke('create-member-login', {
          body: { member_id: created.id, email, password }
        });
        if (loginRes.error || loginRes.data?.error) {
          const code = loginRes.data?.error || loginRes.error?.message || 'LOGIN_CREATE_FAILED';
          toastLive(`${name} saved (${created.member_no})${photoNote}, but login failed: ${code}`);
        } else {
          toastLive(`${name} added · ${created.member_no}${photoNote} · portal account created`);
        }
        close();
        await refreshData(true);
        if (typeof onDone === 'function') onDone();
        else if (currentRole === 'owner') renderOwnerMembers();
        else renderStaffMembers();
      } catch (error) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create member ↗';
        errEl.textContent = friendly(error);
      }
    };

    box.showModal();
    nameInput.focus();
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
    const refWrap = form.querySelector('#renew-reference-wrap');
    const refInput = form.querySelector('#renew-reference');
    const onlineConfirm = form.querySelector('#renew-online-confirm');
    refWrap.hidden = true;
    refInput.required = false;
    onlineConfirm.required = false;
    const paintExpiry = () => {
      const base = member.expires_on && member.expires_on >= phToday() ? new Date(member.expires_on + 'T00:00:00') : new Date(phToday() + 'T00:00:00');
      base.setMonth(base.getMonth() + Number(duration.value));
      document.querySelector('#renew-expiry').textContent = fmtDay(base.toISOString().slice(0, 10));
    };
    paintExpiry();
    duration.onchange = () => {
      form.querySelector('#renew-amount').value = prices[duration.value] || '';
      paintExpiry();
    };
    form.querySelector('#renew-method').onchange = event => {
      const online = event.target.value && event.target.value !== 'Cash';
      refWrap.hidden = !online;
      refInput.required = online;
      onlineConfirm.required = online;
    };
    form.onsubmit = async event => {
      event.preventDefault();
      const months = Number(duration.value);
      const amount = Number(form.querySelector('#renew-amount').value);
      const payMethod = form.querySelector('#renew-method').value;
      const reference = refInput.value.trim();
      if (!payMethod) return toastLive('Select a payment method.');
      if (payMethod !== 'Cash' && (!reference || !onlineConfirm.checked)) return toastLive('Enter the transaction reference and confirm the payment.');
      try {
        let proofPath = null;
        const chosen = proofField?.files?.[0];
        if (chosen) {
          try { await validateImage(chosen); }
          catch (invalidFile) { return toastLive(invalidFile.message); }
          const ext = chosen.type === 'image/png' ? 'png' : chosen.type === 'image/webp' ? 'webp' : 'jpg';
          const upload = await sb.storage.from('payment-proofs').upload(
            `${live.profile.id}/${Date.now()}.${ext}`, chosen, { contentType: chosen.type }
          );
          if (upload.error) return toastLive('The screenshot could not be uploaded. Try again.');
          proofPath = upload.data.path;
        }
        const payment = await ui.call('record_membership_payment', { p_member_id: member.id, p_plan_months: months, p_amount: amount, p_method: payMethod, p_reference: reference || null, p_proof_path: proofPath, p_proof_source: proofPath ? 'staff' : null });
        dialog.close();
        toastLive(payment.status === 'pending' ? `Renewal saved · ${payment.receipt_no} · waiting for owner verification.` : `Membership renewed · ${payment.receipt_no} · now expires ${fmtDay(payment.new_expiry)}.`);
        await refreshData(true);
        if (currentRole === 'owner') renderOwnerMembers();
        else refreshStaff();
      } catch (error) { toastLive(friendly(error)); }
    };
    dialog.querySelector('#renew-close').onclick = () => dialog.close();
    dialog.querySelector('#renew-cancel').onclick = () => dialog.close();
    dialog.showModal();
  }

  function openWalkinModal() {
    const fee = live.settings?.walkin_fee;
    const box = document.createElement('dialog');
    box.className = 'renew-dialog';
    box.id = 'walkin-modal';
    box.innerHTML = `<form class="renew-inner" id="walkin-live">
      <div class="renew-header">
        <div><div class="eyebrow" style="color:#87a278">DAY PASS</div><h2>Record a walk-in</h2><p>Confirm payment before logging a day visitor.</p></div>
        <button type="button" class="renew-close" aria-label="Close">×</button>
      </div>
      <div class="renew-expiry"><span>Walk-in fee</span><strong>${fee === null || fee === undefined ? 'Not set by owner' : peso(fee)}</strong></div>
      <label class="field" for="w-method">Payment method</label>
      <select class="login-input" id="w-method"><option>Cash</option><option>GCash</option><option>Bank transfer</option><option>E-wallet</option><option>Other</option></select>
      <div id="w-ref-wrap" hidden>
        <label class="field" for="w-reference">Online transaction reference</label>
        <input class="login-input" id="w-reference" maxlength="100" placeholder="Enter payment reference">
        <p class="sub">Check the gym’s account independently before confirming.</p>
      </div>
      <label class="field" for="w-amount">Amount received (₱)</label>
      <input class="login-input" id="w-amount" type="number" min="0" step="0.01" value="${fee ?? ''}" required ${fee === null || fee === undefined ? 'disabled' : ''}>
      <p class="sub" style="margin-top:10px">${fee === null || fee === undefined ? 'The owner must set a walk-in fee in Settings first.' : 'Recorded without a visitor name · synced to owner reports.'}</p>
      <div class="renew-actions">
        <button type="button" class="outline" id="w-cancel">Cancel</button>
        <button type="submit" class="login-submit" id="w-submit" ${fee === null || fee === undefined ? 'disabled' : ''}>Confirm walk-in ↗</button>
      </div>
    </form>`;
    document.body.append(box);
    const close = () => { box.close(); box.remove(); };
    box.querySelector('.renew-close').onclick = close;
    box.querySelector('#w-cancel').onclick = close;
    box.addEventListener('cancel', e => { e.preventDefault(); close(); });

    const method = box.querySelector('#w-method');
    method.onchange = () => {
      const online = method.value !== 'Cash';
      box.querySelector('#w-ref-wrap').hidden = !online;
      box.querySelector('#w-reference').required = online;
    };
    let walkinSaving = false;
    box.querySelector('#walkin-live').onsubmit = async event => {
      event.preventDefault();
      if (walkinSaving) return;
      const amount = Number(box.querySelector('#w-amount').value);
      const reference = box.querySelector('#w-reference').value.trim();
      if (method.value !== 'Cash' && !reference) return toastLive('Enter the online payment reference.');
      walkinSaving = true;
      const btn = box.querySelector('#w-submit');
      if (btn) btn.disabled = true;
      try {
        const row = await ui.call('record_walkin', { p_name: null, p_phone: null, p_amount: amount, p_method: method.value, p_reference: reference || null });
        close();
        toastLive(`Walk-in recorded · ${row.receipt_no}`);
        await refreshData(true);
        renderStaffCheckins();
      } catch (error) {
        toastLive(friendly(error));
        walkinSaving = false;
        if (btn && fee !== null && fee !== undefined) btn.disabled = false;
      }
    };
    box.showModal();
  }

  function renderStaffCheckins() {
    const today = phToday();
    const todayVisits = live.visits.filter(v => v.visit_date === today);
    const uniqueToday = new Set(todayVisits.map(v => v.member_id)).size;
    const open = live.visits.filter(v => !v.checked_out_at);
    const expiring = live.members.filter(m => m.expiring_soon).length;
    const fee = live.settings?.walkin_fee;
    const todaysWalkins = live.walkins.filter(w => String(w.visited_on).slice(0, 10) === today);
    const walkinTotal = todaysWalkins.filter(w => !w.voided_at).reduce((n, w) => n + Number(w.amount || 0), 0);
    const walkinCash = todaysWalkins.filter(w => !w.voided_at && w.method === 'Cash').reduce((n, w) => n + Number(w.amount || 0), 0);
    const days7 = lastDays(7);
    const traffic7 = days7.map(d =>
      live.visits.filter(v => String(v.visit_date).slice(0, 10) === d.iso).length
      + live.walkins.filter(w => !w.voided_at && String(w.visited_on).slice(0, 10) === d.iso).length
    );
    const peak7 = Math.max(0, ...traffic7);
    if (!live.staffVisitDate || live.staffVisitDayAnchor !== today) {
      live.staffVisitDate = today;
      live.staffVisitDayAnchor = today;
      live.staffVisitPage = 1;
    }

    staffContent.innerHTML = `
      ${staffHeading('FRONT DESK & ENTRY', 'Check-ins & Walk-ins', 'Search members by name or phone to check in, and log walk-in day passes.', `<button type="button" class="login-submit" id="open-walkin-modal" style="width:auto;height:40px;padding:0 18px">+ Record walk-in ↗</button>`)}
      <div class="rp-top">
        ${bentoHero({
          label: 'TODAY’S GYM TRAFFIC',
          valueHtml: `<strong>${todayVisits.length + todaysWalkins.filter(w => !w.voided_at).length}</strong>`,
          sub: `${uniqueToday} unique member${uniqueToday === 1 ? '' : 's'} · ${todaysWalkins.filter(w => !w.voided_at).length} walk-in${todaysWalkins.length === 1 ? '' : 's'} (${peso(walkinTotal)})`,
          sparkLabel: '7-DAY TRAFFIC',
          sparkPeak: `Peak ${peak7}/day`,
          points: traffic7,
          split: [['OPEN VISITS', open.length], ['WALK-INS TODAY', todaysWalkins.filter(w => !w.voided_at).length], ['WALK-IN SALES', peso(walkinTotal)]]
        })}
        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>MEMBER CHECK-INS</small><strong>${todayVisits.length}</strong><em>${uniqueToday} unique today</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>OPEN VISITS</small><strong>${open.length}</strong><em>inside without exit</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">₱</span><div><small>WALK-IN REVENUE</small><strong>${peso(walkinTotal)}</strong><em>${peso(walkinCash)} cash today</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>DAY-PASS RATE</small><strong>${fee === null || fee === undefined ? '—' : peso(fee)}</strong><em>${expiring} expiring soon</em></div></article>
        </div>
      </div>

      <div class="walkin-layout" style="margin-bottom:16px">
        <section class="card attendance-lookup">
          <div class="staff-kicker">QUICK CHECK-IN</div>
          <h3>Find a member</h3>
          <p>Type a name, phone number, or ID for one-click check-in.</p>
          <input class="login-input" id="att-search" placeholder="Search by name, phone, or ID (e.g. Ian)…" autocomplete="off" aria-label="Find a member by name, phone, or ID">
          <div id="att-results" class="quick-checkin-list"></div>
        </section>

        <div class="checkin-stack">
          <section class="card attendance-current">
            <div class="panel-head"><div><div class="staff-kicker">OPEN VISITS</div><h3>Currently checked in</h3><p>Recorded visits without a checkout.</p></div><span class="status-tag">${open.length} open</span></div>
            ${open.length ? open.map(v => { const m = live.members.find(x => x.id === v.member_id); return `<div class="staff-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m?.full_name || 'Member')}</strong><small>${esc(m?.member_no || '')} · In ${esc(phDateTime(v.checked_in_at))}</small></div><button class="outline att-correct" data-visit="${v.id}">Correct exit</button><button class="outline att-out" data-member="${v.member_id}">Check out</button></div>`; }).join('') : '<div class="attendance-empty">No open visits right now.</div>'}
          </section>

          <section class="staff-walkin-card">
            <div class="panel-head">
              <div><div class="staff-kicker">DAY PASS</div><h3>Today’s walk-ins</h3><p>${todaysWalkins.filter(w => !w.voided_at).length} recorded today.</p></div>
              <div style="display:flex;align-items:center;gap:8px"><span class="status-tag">${peso(walkinTotal)}</span><button type="button" class="outline" id="open-walkin-inline">+ Walk-in</button></div>
            </div>
            <div id="w-list">${todaysWalkins.length ? todaysWalkins.map(p => {
              const pend = hasPendingApproval('void_walkin', p.id);
              const action = p.voided_at
                ? '<span class="status-tag status-deactivated">Voided</span>'
                : pend
                  ? '<span class="status-tag status-expiring">Pending owner</span>'
                  : `<button class="outline staff-req-void" data-kind="void_walkin" data-id="${p.id}" data-label="${esc(p.receipt_no)} · ${peso(p.amount)}">Request void</button>`;
              return `<div class="attention-row"><div><strong>${esc(p.receipt_no)} · Day pass</strong><small>${esc(p.method)}${p.reference ? ' · Ref ' + esc(p.reference) : ''} · ${esc(chTime(p.created_at))}</small></div><span style="${p.voided_at ? 'text-decoration:line-through;opacity:.55' : ''}">${peso(p.amount)}</span>${action}</div>`;
            }).join('') : '<p class="sub">No walk-ins yet today. Use <b>+ Record walk-in</b> to add one.</p>'}</div>
          </section>
        </div>
      </div>

      <section class="staff-table-card">
        <div class="panel-head" style="flex-wrap:wrap;gap:12px">
          <div>
            <div class="staff-kicker" id="visit-log-kicker">${live.staffVisitDate === today ? 'TODAY’S CHECK-INS' : 'PAST CHECK-INS'}</div>
            <h3>Member check-in log</h3>
            <p id="visit-log-sub">Showing ${esc(fmtDay(live.staffVisitDate))} · Philippine time.</p>
          </div>
          <div class="daily-log-controls">
            <button type="button" class="ca-step" id="vl-prev" title="Previous day" aria-label="Previous day">‹</button>
            <input type="date" class="ca-date-input" id="vl-date" value="${esc(live.staffVisitDate)}" max="${today}" aria-label="Check-in log date">
            <button type="button" class="ca-step" id="vl-next" title="Next day" aria-label="Next day" ${live.staffVisitDate >= today ? 'disabled' : ''}>›</button>
            <button type="button" class="outline" id="vl-today" ${live.staffVisitDate === today ? 'disabled' : ''}>Today</button>
          </div>
        </div>
        <div id="vl-list"></div>
        <div id="vl-pager"></div>
      </section>`;

    staffContent.querySelector('#open-walkin-modal').onclick = openWalkinModal;
    staffContent.querySelector('#open-walkin-inline').onclick = openWalkinModal;

    const searchInput = staffContent.querySelector('#att-search');
    const resultsBox = staffContent.querySelector('#att-results');
    const drawLookup = () => {
      const q = (searchInput?.value || '').trim().toLowerCase();
      const pool = live.members.filter(m => !m.archived_at && !m.merged_into);
      const matches = q
        ? pool.filter(m => [m.full_name, m.phone, m.email, m.member_no].join(' ').toLowerCase().includes(q)).slice(0, 7)
        : pool.filter(m => m.effective_status === 'Active').slice(0, 5);
      if (!matches.length) {
        resultsBox.innerHTML = `<p class="sub" style="padding:12px 0">${q ? 'No matching members found. Try another name or phone number.' : 'No active members yet.'}</p>`;
        return;
      }
      resultsBox.innerHTML = matches.map(m => {
        const isOpen = open.some(v => v.member_id === m.id);
        const btn = isOpen
          ? `<button type="button" class="outline quick-act-out" data-id="${m.id}">Check out</button>`
          : m.effective_status === 'Active'
            ? `<button type="button" class="login-submit quick-checkin-btn quick-act-in" data-id="${m.id}">Check in ↗</button>`
            : `<button type="button" class="outline quick-act-renew" data-id="${m.id}">Renew</button>`;
        return `<div class="quick-checkin-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m.full_name)}</strong><small>${esc(m.member_no)}${m.phone ? ' · ' + esc(m.phone) : ''} · ${m.expires_on ? 'exp ' + esc(fmtDay(m.expires_on)) : 'No plan'}</small></div><div class="quick-checkin-actions"><span class="status-tag ${m.effective_status === 'Active' ? '' : 'status-deactivated'}">${isOpen ? 'Inside' : m.effective_status}</span>${btn}</div></div>`;
      }).join('');

      resultsBox.querySelectorAll('.quick-act-in').forEach(b => b.onclick = async () => {
        const m = live.members.find(x => x.id === b.dataset.id);
        if (!m) return;
        try { await ui.call('check_in', { p_member_id: m.id }); toastLive(`${m.full_name} checked in.`); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
      });
      resultsBox.querySelectorAll('.quick-act-out').forEach(b => b.onclick = async () => {
        const m = live.members.find(x => x.id === b.dataset.id);
        try { await ui.call('check_out', { p_member_id: b.dataset.id }); toastLive(`${m?.full_name || 'Member'} checked out.`); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
      });
      resultsBox.querySelectorAll('.quick-act-renew').forEach(b => b.onclick = () => openRenewalLive(b.dataset.id));
    };
    if (searchInput) searchInput.oninput = drawLookup;
    drawLookup();

    const shiftIso = (iso, delta) => {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
    };
    const visitCache = new Map();
    const V_PAGE_SIZE = 6;
    const paintVisitDay = rows => {
      const listEl = staffContent.querySelector('#vl-list');
      const pagerEl = staffContent.querySelector('#vl-pager');
      const subEl = staffContent.querySelector('#visit-log-sub');
      const kickerEl = staffContent.querySelector('#visit-log-kicker');
      if (!listEl || !listEl.isConnected) return;
      const dStr = live.staffVisitDate;
      if (kickerEl) kickerEl.textContent = dStr === today ? 'TODAY’S CHECK-INS' : 'PAST CHECK-INS';
      if (subEl) subEl.textContent = `${rows.length} visit${rows.length === 1 ? '' : 's'} on ${fmtDay(dStr)} · Philippine time.`;
      if (!rows.length) {
        listEl.innerHTML = `<div class="attendance-empty">No check-ins recorded on ${esc(fmtDay(dStr))}.</div>`;
        if (pagerEl) pagerEl.innerHTML = '';
        return;
      }
      const totalPages = Math.max(1, Math.ceil(rows.length / V_PAGE_SIZE));
      if (live.staffVisitPage > totalPages) live.staffVisitPage = totalPages;
      const page = live.staffVisitPage;
      const slice = rows.slice((page - 1) * V_PAGE_SIZE, page * V_PAGE_SIZE);
      listEl.innerHTML = slice.map(v => {
        const m = live.members.find(x => x.id === v.member_id);
        return `<div class="staff-row">${memberAvatar(m)}<div class="staff-row-main"><strong>${esc(m?.full_name || 'Member')} · ${v.checked_out_at ? 'Checkout' : 'Check-in'}</strong><small>${esc(m?.member_no || '')} · ${esc(phDateTime(v.checked_out_at || v.checked_in_at))}</small></div></div>`;
      }).join('');
      if (!pagerEl) return;
      if (totalPages <= 1) { pagerEl.innerHTML = ''; return; }
      const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(n => n === 1 || n === totalPages || Math.abs(n - page) <= 1);
      let nums = '', prev = 0;
      for (const n of pages) {
        if (prev && n - prev > 1) nums += '<span class="owner-pager-gap">…</span>';
        nums += `<button type="button" class="owner-page-num ${n === page ? 'is-current' : ''}" data-vp="${n}">${n}</button>`;
        prev = n;
      }
      pagerEl.innerHTML = `<div class="owner-pager"><span class="owner-pager-count">Showing ${(page - 1) * V_PAGE_SIZE + 1}–${Math.min(page * V_PAGE_SIZE, rows.length)} of ${rows.length}</span><div class="owner-pager-buttons"><button type="button" class="outline" id="vp-prev" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button><div class="owner-pager-pages">${nums}</div><button type="button" class="outline" id="vp-next" ${page >= totalPages ? 'disabled' : ''}>Next ›</button></div></div>`;
      pagerEl.querySelector('#vp-prev')?.addEventListener('click', () => { live.staffVisitPage -= 1; paintVisitDay(rows); });
      pagerEl.querySelector('#vp-next')?.addEventListener('click', () => { live.staffVisitPage += 1; paintVisitDay(rows); });
      pagerEl.querySelectorAll('[data-vp]').forEach(btn => btn.onclick = () => { live.staffVisitPage = Number(btn.dataset.vp); paintVisitDay(rows); });
    };
    const loadVisitDay = async () => {
      const dStr = live.staffVisitDate;
      const dInput = staffContent.querySelector('#vl-date');
      const prevBtn = staffContent.querySelector('#vl-prev');
      const nextBtn = staffContent.querySelector('#vl-next');
      const todayBtn = staffContent.querySelector('#vl-today');
      if (dInput) dInput.value = dStr;
      if (nextBtn) nextBtn.disabled = dStr >= today;
      if (todayBtn) todayBtn.disabled = dStr === today;
      const localMatches = live.visits.filter(v => String(v.visit_date).slice(0, 10) === dStr);
      paintVisitDay(visitCache.get(dStr) || localMatches);
      try {
        const { data, error } = await sb.from('attendance_visits').select('*').eq('visit_date', dStr).order('checked_in_at', { ascending: false }).limit(200);
        if (!error && Array.isArray(data)) {
          const rows = data.length || dStr !== today ? data : localMatches;
          visitCache.set(dStr, rows);
          paintVisitDay(rows);
        }
      } catch { /* keep localMatches */ }
      if (prevBtn) prevBtn.onclick = () => { live.staffVisitDate = shiftIso(live.staffVisitDate, -1); live.staffVisitPage = 1; loadVisitDay(); };
      if (nextBtn) nextBtn.onclick = () => { const n = shiftIso(live.staffVisitDate, 1); live.staffVisitDate = n > today ? today : n; live.staffVisitPage = 1; loadVisitDay(); };
      if (todayBtn) todayBtn.onclick = () => { live.staffVisitDate = today; live.staffVisitPage = 1; loadVisitDay(); };
      if (dInput) dInput.onchange = () => { if (dInput.value) { live.staffVisitDate = dInput.value > today ? today : dInput.value; live.staffVisitPage = 1; loadVisitDay(); } };
    };
    loadVisitDay();

    staffContent.querySelectorAll('.att-out').forEach(button => button.onclick = async () => {
      try { await ui.call('check_out', { p_member_id: button.dataset.member }); toastLive('Checkout recorded.'); await refreshData(true); renderStaffCheckins(); } catch (error) { toastLive(friendly(error)); }
    });
    staffContent.querySelectorAll('.att-correct').forEach(button => button.onclick = () => correctVisit(button.dataset.visit));
    staffContent.querySelectorAll('.staff-req-void').forEach(button => button.onclick = () => requestOwnerApproval(button.dataset.kind, button.dataset.id, button.dataset.label, renderStaffCheckins));
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
    const today = phToday();
    const items = live.inventory.filter(i => i.is_active);
    const low = items.filter(i => i.quantity <= i.threshold);
    const out = items.filter(i => i.quantity === 0);
    const todaySalesRows = live.sales.filter(s => !s.voided_at && String(s.sold_on).slice(0, 10) === today);
    const todaySalesTotal = todaySalesRows.reduce((n, s) => n + Number(s.total || 0), 0);
    const days7 = lastDays(7);
    const sales7 = days7.map(d => live.sales.filter(s => !s.voided_at && String(s.sold_on).slice(0, 10) === d.iso).reduce((n, s) => n + Number(s.total || 0), 0));
    const peak7 = Math.max(0, ...sales7);

    staffContent.innerHTML = `
      ${staffHeading('THE GYM SHOP', 'Product sales', 'Select products, confirm payment and issue an e-receipt.')}
      <div class="rp-top">
        ${bentoHero({
          label: 'TODAY’S PRODUCT SALES',
          valueHtml: `<strong>${peso(todaySalesTotal)}</strong>`,
          sub: `${todaySalesRows.length} receipt${todaySalesRows.length === 1 ? '' : 's'} issued today`,
          sparkLabel: '7-DAY SHOP SALES',
          sparkPeak: `Peak ${peso(peak7)}`,
          points: sales7,
          split: [['PRODUCTS', items.length], ['LOW STOCK', low.length], ['OUT OF STOCK', out.length]]
        })}
        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>PRODUCTS</small><strong>${items.length}</strong><em>available for sale</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>LOW STOCK</small><strong>${low.length}</strong><em>at or below threshold</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>OUT OF STOCK</small><strong>${out.length}</strong><em>restock needed</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">₱</span><div><small>RECEIPTS TODAY</small><strong>${todaySalesRows.length}</strong><em>product sales</em></div></article>
        </div>
      </div>
      <section class="staff-pos-card owner-directory"><div class="panel-head"><div><div class="staff-kicker">POINT OF SALE</div><h3>Sale cart</h3><p>Add products to the cart — the total and change update automatically.</p></div></div>
        <div class="inventory-list">${items.map(item => `<div class="inventory-row"><span class="inventory-icon">${productIcon(item.name)}</span><div><strong>${esc(item.name)}</strong><small>${peso(item.price)} each · ${item.quantity} ${esc(item.unit)} in stock</small></div><span class="status-tag ${item.quantity <= item.threshold ? 'status-expiring' : ''}">${item.quantity === 0 ? 'Out of stock' : item.quantity <= item.threshold ? 'Low stock' : 'In stock'}</span><div class="inventory-actions"><button class="outline add-to-cart" data-id="${item.id}" ${item.quantity === 0 ? 'disabled' : ''}>Add to cart</button></div></div>`).join('') || '<p class="sub">No products yet. The owner adds products in their inventory page.</p>'}</div>
        <div id="cart-panel" class="cart-panel" hidden></div></section>
      <section class="staff-table-card" style="margin-top:16px">
        <div class="panel-head"><div><div class="staff-kicker">TODAY’S SALES</div><h3>Receipts issued today</h3><p>Wrong input? Request a void — only the owner can approve reversals.</p></div><span class="status-tag">${peso(todaySalesTotal)}</span></div>
        ${live.sales.filter(s => String(s.sold_on).slice(0, 10) === today).map(s => {
          const pend = hasPendingApproval('void_sale', s.id);
          const action = s.voided_at
            ? '<span class="status-tag status-deactivated">Voided</span>'
            : pend
              ? '<span class="status-tag status-expiring">Pending owner</span>'
              : `<button class="outline staff-req-void" data-kind="void_sale" data-id="${s.id}" data-label="${esc(s.receipt_no)} · ${peso(s.total)}">Request void</button>`;
          return `<div class="attention-row"><div><strong>${esc(s.receipt_no)} · ${esc(s.customer_name || 'Walk-in customer')}</strong><small>${esc(s.method)}${s.reference ? ' · Ref ' + esc(s.reference) : ''} · ${esc(chTime(s.created_at))}</small></div><span style="${s.voided_at ? 'text-decoration:line-through;opacity:.55' : ''}">${peso(s.total)}</span>${action}</div>`;
        }).join('') || '<p class="sub">No product sales recorded yet today.</p>'}
      </section>`;
    staffContent.querySelectorAll('.staff-req-void').forEach(button => button.onclick = () => requestOwnerApproval(button.dataset.kind, button.dataset.id, button.dataset.label, renderStaffInventory));
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
  const financeCache = new Map();

  function computeLocalFinance(range) {
    const inRange = d => d && String(d).slice(0, 10) >= range.from && String(d).slice(0, 10) <= range.to;
    const liveRow = r => !r.voided_at;
    const payRows = live.payments.filter(p => p.status === 'approved' && liveRow(p) && inRange(p.paid_on));
    const walkRows = live.walkins.filter(w => liveRow(w) && inRange(w.visited_on));
    const saleRows = live.sales.filter(s => liveRow(s) && inRange(s.sold_on));
    const expRows = (live.expenses || []).filter(e => inRange(e.spent_on));
    const liveExp = expRows.filter(liveRow);

    const membership = payRows.filter(p => p.category === 'membership').reduce((n, p) => n + Number(p.amount || 0), 0);
    const other = payRows.filter(p => p.category !== 'membership').reduce((n, p) => n + Number(p.amount || 0), 0);
    const walkin = walkRows.reduce((n, w) => n + Number(w.amount || 0), 0);
    const product = saleRows.reduce((n, s) => n + Number(s.total || 0), 0);
    const revTotal = membership + walkin + product + other;
    const expTotal = liveExp.reduce((n, e) => n + Number(e.amount || 0), 0);
    const vat = [...payRows, ...walkRows, ...saleRows].reduce((n, r) => n + Number(r.vat_amount || 0), 0);

    const catMap = {};
    liveExp.forEach(e => { catMap[e.category || 'Other'] = (catMap[e.category || 'Other'] || 0) + Number(e.amount || 0); });
    const by_category = Object.entries(catMap).map(([category, total]) => ({ category, total }));

    const series = [];
    const cur = new Date(range.from + 'T00:00:00Z');
    const last = new Date(range.to + 'T00:00:00Z');
    while (cur <= last && series.length < 370) {
      const iso = cur.toISOString().slice(0, 10);
      const dayRev = payRows.filter(p => String(p.paid_on).slice(0, 10) === iso).reduce((n, p) => n + Number(p.amount || 0), 0)
        + walkRows.filter(w => String(w.visited_on).slice(0, 10) === iso).reduce((n, w) => n + Number(w.amount || 0), 0)
        + saleRows.filter(s => String(s.sold_on).slice(0, 10) === iso).reduce((n, s) => n + Number(s.total || 0), 0);
      const dayExp = liveExp.filter(e => String(e.spent_on).slice(0, 10) === iso).reduce((n, e) => n + Number(e.amount || 0), 0);
      series.push({ date: iso, revenue: dayRev, expenses: dayExp });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    return {
      report: {
        revenue: { membership, walkin, product, other, total: revTotal },
        expenses: { total: expTotal, by_category },
        cogs: 0,
        gross_profit: revTotal,
        net_profit: revTotal - expTotal,
        vat_collected: vat,
        series
      },
      expenses: expRows
    };
  }

  function paintFinanceBody(body, range, report, expenses) {
    const rev = report.revenue, exp = report.expenses;
    const liveExpenses = (expenses || []).filter(e => !e.voided_at);
    const label = periodText();
    const chartSeries = (report.series || []).slice(-14);
    const maxBar = Math.max(1, ...chartSeries.map(d => Math.max(Number(d.revenue), Number(d.expenses))));

    const margin = rev.total ? Math.round((Number(report.net_profit) / Number(rev.total)) * 100) : 0;
    const catRows = (exp.by_category || []).filter(c => Number(c.total) > 0).sort((a, b) => Number(b.total) - Number(a.total));
    const catMax = Math.max(1, ...catRows.map(c => Number(c.total)));
    const positive = Number(report.net_profit) >= 0;

    body.innerHTML = `
      <div class="rp-top">
        ${bentoHero({
          label: `NET PROFIT · ${label.toUpperCase()}`,
          valueHtml: `<strong class="${positive ? '' : 'rp-hero-loss'}">${signedPeso(report.net_profit)}</strong>`,
          sub: `After cost of goods and expenses · ${margin}% margin`,
          sparkLabel: 'REVENUE PULSE',
          sparkPeak: `${margin}% margin`,
          points: chartSeries.slice(-7).map(d => Number(d.revenue || 0)),
          split: [['REVENUE', peso(rev.total)], ['EXPENSES', peso(exp.total)], ['VAT COLLECTED', peso(report.vat_collected)]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">↗</span><div><small>REVENUE</small><strong>${peso(rev.total)}</strong><em>${label} · all sources</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>EXPENSES</small><strong>${peso(exp.total)}</strong><em>${liveExpenses.length} entries</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>GROSS PROFIT</small><strong>${signedPeso(report.gross_profit)}</strong><em>before expenses</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>VAT COLLECTED</small><strong>${peso(report.vat_collected)}</strong><em>${live.settings?.vat_registered ? 'registered · set aside this' : 'not VAT registered'}</em></div></article>
        </div>
      </div>

      <div class="rp-mid">
        <section class="card rp-chart-card">
          <div class="panel-head"><div><div class="staff-kicker">DAILY TREND</div><h3>Revenue vs expenses</h3><p>Day by day, ${label.toLowerCase()}.</p></div>
            <div class="rp-legend"><span><i class="rp-dot rp-dot-rev"></i>Revenue</span><span><i class="rp-dot rp-dot-exp"></i>Expenses</span></div>
          </div>
          <div class="finance-chart">${chartSeries.map(d => `<div class="fc-col" title="${esc(d.date)} · in ${peso(d.revenue)} · out ${peso(d.expenses)}"><div class="fc-bars"><i class="fc-in" style="height:${Number(d.revenue) > 0 ? Math.max(4, (Number(d.revenue) / maxBar) * 100) : 0}%"></i><i class="fc-out" style="height:${Number(d.expenses) > 0 ? Math.max(4, (Number(d.expenses) / maxBar) * 100) : 0}%"></i></div><small>${esc(String(d.date).slice(8))}</small></div>`).join('')}</div>
        </section>

        <section class="card rp-mix-card">
          <div class="panel-head"><div><div class="staff-kicker">WHERE IT COMES FROM</div><h3>Revenue split</h3><p>${label}, before costs.</p></div></div>
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
      </div>

      <div class="rp-mid">
        <section class="card page-panel">
          <div class="panel-head"><div><div class="staff-kicker">MONEY OUT</div><h3>Expenses</h3><p>Rent, bills, salaries — everything that leaves the till.</p></div><button class="login-submit" id="expense-new" style="width:auto;height:38px;padding:0 16px">+ Record expense</button></div>
          <div id="expense-form-slot"></div>
          ${liveExpenses.length ? `<div class="expense-list">${liveExpenses.map(e => `<div class="expense-row${e.voided_at ? ' row-is-voided' : ''}"><div><strong>${esc(e.description)}</strong><small>${esc(e.category)} · ${esc(fmtDay(e.spent_on))}${e.vendor ? ' · ' + esc(e.vendor) : ''} · ${esc(e.method)}${e.paid_from_drawer ? ' (drawer)' : ''}</small></div><span>${peso(e.amount)}</span>${e.voided_at ? `<small class="void-reason">${esc(e.void_reason || 'voided')}</small>` : `<button class="outline expense-void" data-id="${e.id}" data-desc="${esc(e.description)}">Void</button>`}</div>`).join('')}</div>` : '<p class="sub" style="padding:12px 0">No expenses recorded for this period.</p>'}
        </section>

        <div class="rp-side-stack">
          <section class="card rp-mix-card">
            <div class="panel-head"><div><div class="staff-kicker">SPENDING BY CATEGORY</div><h3>Where it went</h3><p>Biggest expense categories this period.</p></div></div>
            ${catRows.length ? catRows.slice(0, 6).map(c => `<div class="rp-method"><div class="rp-method-head"><span>${esc(c.category)}</span><b>${peso(c.total)}</b></div><div class="rp-method-bar"><span style="width:${Math.round((Number(c.total) / catMax) * 100)}%"></span></div></div>`).join('') : '<p class="sub">No expenses recorded in this period yet.</p>'}
          </section>
          <section class="card rp-export-card">
            <div class="panel-head"><div><div class="staff-kicker">TAKE IT OFFLINE</div><h3>Export</h3><p>Profit report and tax summary as CSV.</p></div></div>
            <div class="rp-export-figure"><strong>${peso(rev.total)}</strong><span>revenue · ${peso(exp.total)} spent</span></div>
            <button class="login-submit" id="finance-export">Export profit report ↓</button>
            <button class="outline" id="finance-tax" style="width:100%;height:40px;margin-top:8px;border-radius:9px">Tax summary (BIR)</button>
            <p class="rp-export-note">Opens as CSV — Excel, Numbers or Google Sheets.</p>
          </section>
        </div>
      </div>`;

    const refresh = () => loadFinance(range, true);
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

  function renderOwnerFinance() {
    const range = currentPeriodRange();
    const key = `${range.from}:${range.to}`;
    const snap = financeCache.get(key) || computeLocalFinance(range);
    ownerContent.innerHTML = `
      <div class="rp-head"><div><div class="eyebrow" style="color:#8ba284">MONEY IN, MONEY OUT</div><h2>Finance</h2><p>What the gym earned, what it spent, and what's actually left.</p></div></div>
      <div id="finance-body"></div>`;
    const body = ownerContent.querySelector('#finance-body');
    if (body) paintFinanceBody(body, range, snap.report, snap.expenses);
    loadFinance(range, false, snap);
  }

  async function loadFinance(range, forceAnimate = false, renderedSnap = null) {
    const body = ownerContent.querySelector('#finance-body');
    if (!body || !body.isConnected) return;
    const key = `${range.from}:${range.to}`;
    const sig = s => `${s.report.net_profit}|${s.report.revenue.total}|${s.report.expenses.total}|${s.report.cogs}|${s.report.vat_collected}|${(s.expenses || []).length}`;
    try {
      const [report, expRes] = await Promise.all([
        call('profit_report', { p_from: range.from, p_to: range.to }),
        sb.from('expenses').select('*').gte('spent_on', range.from).lte('spent_on', range.to).order('spent_on', { ascending: false })
      ]);
      const fresh = { report, expenses: expRes?.data || [] };
      financeCache.set(key, fresh);
      if (!body.isConnected) return;
      if (forceAnimate || !renderedSnap || sig(fresh) !== sig(renderedSnap)) {
        paintFinanceBody(body, range, fresh.report, fresh.expenses);
        if (forceAnimate) revealDashboard(ownerContent);
      }
    } catch (error) {
      if (!renderedSnap && body.isConnected) body.innerHTML = `<p class="sub">${esc(friendly(error))}</p>`;
    }
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
  /* Cash drawer tab removed at the owner’s request. The cash_day_summary /
     close_cash_day / reopen_cash_day database functions are untouched, so this
     can be restored by putting the nav button and these two functions back. */

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
    const total = live.activity.length;
    const today = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
    const todayCount = live.activity.filter(a => phDateTime(a.created_at).includes(today)).length;
    const actors = new Set(live.activity.map(a => a.actor_name || 'Gym')).size;
    const kinds = new Set(live.activity.map(a => a.kind || 'action')).size;

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">EVERY ACTION, ON THE RECORD</div>
          <h2>Activity log</h2>
          <p>Who did what, and when. Nothing here can be edited or erased.</p>
        </div>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: 'RECORDED ACTIONS',
          valueHtml: `<strong>${total}</strong>`,
          sub: `${todayCount} today · ${actors} people active`,
          sparkLabel: '7-DAY PULSE',
          sparkPeak: `${todayCount} today`,
          points: lastDays(7).map(d => live.activity.filter(a => String(a.created_at).slice(0, 10) === d.iso).length),
          split: [['TODAY', todayCount], ['PEOPLE', actors], ['ACTION TYPES', kinds]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>TOTAL ACTIONS</small><strong>${total}</strong><em>on the record</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>TODAY</small><strong>${todayCount}</strong><em>actions logged</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">♙</span><div><small>PEOPLE ACTIVE</small><strong>${actors}</strong><em>staff and members</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">▤</span><div><small>ACTION TYPES</small><strong>${kinds}</strong><em>kinds of activity</em></div></article>
        </div>
      </div>

      <section class="card page-panel">
        <div class="panel-head"><div><div class="staff-kicker">SEARCH THE LOG</div><h3>Find an action</h3><p>Filter by text, action type or date.</p></div><button class="outline" id="log-export">Export CSV ↓</button></div>
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
        const PAGE_SIZE = 15;
        let page = 1;
        const drawLogs = () => {
          if (!rows.length) {
            box.innerHTML = '<p class="sub">No entries match that search.</p>';
            return;
          }
          const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
          page = Math.max(1, Math.min(page, pages));
          const start = (page - 1) * PAGE_SIZE;
          const slice = rows.slice(start, start + PAGE_SIZE);
          box.innerHTML = `<div class="log-list">${slice.map(r => `<div class="log-row"><span class="log-kind">${esc(String(r.kind||'').replace(/_/g,' '))}</span><div><strong>${esc(r.summary)}</strong><small>${esc(r.actor_name || 'Gym')} · ${esc(phDateTime(r.created_at))}</small></div></div>`).join('')}</div>
            ${pages > 1 ? `<div class="owner-pager" id="log-pager">
              <span class="owner-pager-count">Showing ${start + 1}–${Math.min(start + PAGE_SIZE, rows.length)} of ${rows.length}</span>
              <div class="owner-pager-buttons">
                <button class="outline log-page-prev" type="button" ${page <= 1 ? 'disabled' : ''}>‹ Prev</button>
                <span class="owner-pager-pages">${Array.from({ length: pages }, (_, i) => i + 1).filter(p => p === 1 || p === pages || Math.abs(p - page) <= 1).map((p, idx, arr) => `${idx && p - arr[idx - 1] > 1 ? '<span class="owner-pager-gap">…</span>' : ''}<button type="button" class="owner-page-num ${p === page ? 'is-current' : ''}" data-page="${p}">${p}</button>`).join('')}</span>
                <button class="outline log-page-next" type="button" ${page >= pages ? 'disabled' : ''}>Next ›</button>
              </div>
            </div>` : ''}`;
          box.querySelector('.log-page-prev')?.addEventListener('click', () => { page -= 1; drawLogs(); });
          box.querySelector('.log-page-next')?.addEventListener('click', () => { page += 1; drawLogs(); });
          box.querySelectorAll('.owner-page-num').forEach(b => b.addEventListener('click', () => { page = Number(b.dataset.page); drawLogs(); }));
        };
        drawLogs();
        const exportBtn = ownerContent.querySelector('#log-export');
        if (exportBtn) exportBtn.onclick = () => downloadCsv('gimmda-activity.csv', [['When','Type','Who','What'], ...rows.map(r => [phDateTime(r.created_at), r.kind, r.actor_name||'', r.summary])]);
      } catch (error) { box.innerHTML = `<p class="sub">${esc(friendly(error))}</p>`; }
    };
    ownerContent.querySelector('#log-run').onclick = run;
    ownerContent.querySelector('#log-q').onkeydown = e => { if (e.key === 'Enter') run(); };
    run();
  }

  /* ---- Feedback: what members are telling the gym ------------------------ */
  function renderOwnerFeedback() {
    const all = live.feedback || [];
    const memberOf = f => live.members.find(m => m.id === f.member_id);
    const today = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
    const todayCount = all.filter(f => phDateTime(f.created_at).includes(today)).length;
    const weekCount = all.filter(f => {
      const d = new Date(f.created_at);
      return (Date.now() - d.getTime()) < 7 * 24 * 3600 * 1000;
    }).length;
    const words = all.reduce((n, f) => n + String(f.body || '').trim().split(/\s+/).filter(Boolean).length, 0);
    const latest = all[0];

    ownerContent.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="eyebrow" style="color:#8ba284">WHAT MEMBERS ARE SAYING</div>
          <h2>Feedback</h2>
          <p>Messages members sent from their portal, newest first.</p>
        </div>
      </div>

      <div class="rp-top">
        ${bentoHero({
          label: 'MESSAGES RECEIVED',
          valueHtml: `<strong>${all.length}</strong>`,
          sub: `${todayCount} today · ${weekCount} this week`,
          sparkLabel: '7-DAY INBOX',
          sparkPeak: `${weekCount} this week`,
          points: lastDays(7).map(d => all.filter(f => String(f.created_at).slice(0, 10) === d.iso).length),
          split: [['TODAY', todayCount], ['THIS WEEK', weekCount], ['WORDS SHARED', words]]
        })}

        <div class="rp-kpis">
          <article class="rp-kpi"><span class="rp-kpi-icon">✉</span><div><small>MESSAGES</small><strong>${all.length}</strong><em>from members</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">◷</span><div><small>TODAY</small><strong>${todayCount}</strong><em>arrived today</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">↗</span><div><small>THIS WEEK</small><strong>${weekCount}</strong><em>last 7 days</em></div></article>
          <article class="rp-kpi"><span class="rp-kpi-icon">✳</span><div><small>WORDS SHARED</small><strong>${words}</strong><em>across all messages</em></div></article>
        </div>
      </div>

      ${latest ? `<section class="card rp-latest">
        <div class="panel-head"><div><div class="staff-kicker">MOST RECENT</div><h3>Latest message</h3></div><span class="rp-pill">${esc(phDateTime(latest.created_at))}</span></div>
        <div class="rp-latest-body">
          ${memberAvatar(memberOf(latest))}
          <div><strong>${esc(memberOf(latest)?.full_name || 'Member')}</strong><p>${esc(latest.body)}</p></div>
        </div>
      </section>` : ''}

      <section class="card page-panel rp-table-card">
        <div class="panel-head"><div><div class="staff-kicker">THE INBOX</div><h3>All feedback</h3><p>Every message members have sent, newest first.</p></div><button class="outline" id="fb-export">Export CSV ↓</button></div>
        ${all.length ? `<div class="fb-list">${all.map(f => {
          const m = memberOf(f);
          return `<div class="fb-row">
            ${memberAvatar(m)}
            <div class="fb-main">
              <div class="fb-head"><strong>${esc(m?.full_name || 'Member')}</strong><span>${esc(m?.member_no || '')}</span><time>${esc(phDateTime(f.created_at))}</time></div>
              <p>${esc(f.body)}</p>
            </div>
          </div>`;
        }).join('')}</div>` : '<p class="sub" style="padding:12px 0">No feedback yet. Members can send messages from their portal — they will appear here.</p>'}
      </section>`;

    const exportBtn = ownerContent.querySelector('#fb-export');
    if (exportBtn) exportBtn.onclick = () => downloadCsv('gimmda-feedback.csv', [['When', 'Member', 'Member no.', 'Message'], ...all.map(f => [phDateTime(f.created_at), memberOf(f)?.full_name || '', memberOf(f)?.member_no || '', f.body])]);
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
