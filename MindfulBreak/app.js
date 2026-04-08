'use strict';

    /* =============================================
       DEFAULT STATE
       ============================================= */
    const DEFAULT_STATE = {
      // Timer
      timerMode: 'work',
      timerRunning: false,
      timerRemaining: 25 * 60,
      sessionsCompleted: 0,
      totalSessionsToday: 0,

      // Burnout
      burnoutScore: 0,
      burnoutHistory: [],

      // User
      activityType: 'coding',
      miloColorTheme: 'orange',
      onboardingComplete: false,

      // Settings
      settings: {
        workDuration: 25,
        shortBreakDuration: 5,
        longBreakDuration: 15,
        notificationsEnabled: true,
        soundEnabled: true,
        dailyWaterGoal: 8,
        burnoutThreshold: 80,
        sessionCount: 4
      },

      // Health
      waterIntakeToday: 0,
      streakDays: 0,
      lastActiveDate: null,

      // Achievements
      achievements: {
        hydrationHero: false,
        sevenDayWarrior: false,
        eyeProtector: 0,
        eyeProtectorUnlocked: false,
        burnoutBuster: false,
        burnoutBusterPrevHigh: false,
        stretchMaster: 0,
        stretchMasterUnlocked: false
      },

      // Breaks
      breakHistory: [],
      sessionHistory: []
    };

    /* =============================================
       APP STATE -> deep clone of defaults
       ============================================= */
    let AppState = JSON.parse(JSON.stringify(DEFAULT_STATE));

    /* =============================================
       STORAGE MANAGER
       ============================================= */
    const StorageManager = (() => {
      const STORAGE_KEY = 'mindfulbreak_state';
      let _debounceTimer = null;
      let _storageAvailable = true;

      /** Check if localStorage is accessible */
      function _checkStorage() {
        try {
          const test = '__mindfulbreak_test__';
          localStorage.setItem(test, '1');
          localStorage.removeItem(test);
          return true;
        } catch (e) {
          return false;
        }
      }

      /**
       * Persist AppState to localStorage.
       * Writes are debounced by 300 ms to avoid excessive I/O.
       */
      function save(state) {
        if (!_storageAvailable) return;
        clearTimeout(_debounceTimer);
        _debounceTimer = setTimeout(() => {
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          } catch (e) {
            _storageAvailable = false;
            showToast("Data won't be saved in this session");
          }
        }, 300);
      }

      /**
       * Load AppState from localStorage.
       * Returns the parsed object or null if nothing is stored.
       */
      function load() {
        if (!_storageAvailable) return null;
        try {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (!raw) return null;
          return JSON.parse(raw);
        } catch (e) {
          return null;
        }
      }

      /**
       * Clear the stored state and reload defaults.
       * Does NOT reload the page -> callers should reinitialise AppState.
       */
      function reset() {
        if (!_storageAvailable) return;
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch (e) {
          // ignore
        }
      }

      /**
       * Update the streak counter based on the current calendar date.
       *
       * Rules:
       *  - If lastActiveDate === today  -> no-op (already counted)
       *  - If lastActiveDate === yesterday -> increment streakDays
       *  - Otherwise (missed day or first use) -> reset to 1
       *
       * Always updates lastActiveDate to today and persists.
       */
      function updateStreak() {
        const today = _toDateString(Date.now());
        const last = AppState.lastActiveDate;

        if (last === today) return; // already counted today

        const yesterday = _toDateString(Date.now() - 86400000);

        if (last === yesterday) {
          AppState.streakDays = AppState.streakDays + 1;
        } else {
          AppState.streakDays = 1; // streak broken or first use
        }

        AppState.lastActiveDate = today;
        save(AppState);
      }

      /** Convert a timestamp (ms) to a YYYY-MM-DD string in local time */
      function _toDateString(ms) {
        const d = new Date(ms);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
      }

      // Initialise storage availability flag
      _storageAvailable = _checkStorage();

      return { save, load, reset, updateStreak };
    })();

    /* =============================================
       TOAST UTILITY
       ============================================= */
    function showToast(message, duration = 4000) {
      const container = document.getElementById('toast-container');
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      container.appendChild(toast);

      // Trigger transition on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          toast.classList.add('toast--visible');
        });
      });

      setTimeout(() => {
        toast.classList.remove('toast--visible');
        setTimeout(() => toast.remove(), 350);
      }, duration);
    }

    /* =============================================
       PAGE NAVIGATION
       ============================================= */
    function showPage(name) {
      // Hide all pages
      document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('page--active');
      });

      // Show target page
      const target = document.getElementById(`page-${name}`);
      if (target) {
        target.classList.add('page--active');
      }

      // Show/hide nav and footer (hidden on landing)
      const isLanding = name === 'landing';
      document.getElementById('top-nav').style.display = isLanding ? 'none' : 'flex';
      document.getElementById('app-footer').style.display = isLanding ? 'none' : 'flex';
      const ftBar = document.getElementById('floating-toolbar');
      if (ftBar) ftBar.style.display = isLanding ? 'none' : 'flex';

      // Update active nav link
      document.querySelectorAll('.top-nav__links a').forEach(a => {
        a.classList.toggle('active', a.dataset.nav === name);
      });

      // Page-specific hooks
      if (name === 'history')  renderHistoryPage();
      if (name === 'settings') initSettingsPage();
      if (name === 'todo' && typeof TodoPage !== 'undefined') TodoPage.render();
    }

    /* =============================================
       NAV LINK CLICK HANDLERS
       ============================================= */
    document.querySelectorAll('.top-nav__links a').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        showPage(a.dataset.nav);
      });
    });

    /* =============================================
       TIMER ENGINE
       ============================================= */
    const TimerEngine = (() => {
      const CIRCUMFERENCE = 2 * Math.PI * 80; // -> 502.65

      let _intervalId = null;
      let _tickCallbacks = [];
      let _sessionCompleteCallbacks = [];

      /** Total duration in seconds for the current mode */
      function _totalDuration() {
        const s = AppState.settings;
        if (AppState.timerMode === 'work')       return s.workDuration * 60;
        if (AppState.timerMode === 'shortBreak') return s.shortBreakDuration * 60;
        if (AppState.timerMode === 'longBreak')  return s.longBreakDuration * 60;
        return s.workDuration * 60;
      }

      /** Clamp a value between min and max */
      function _clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
      }

      /** Update the DOM: time display, mode label, ring progress, button text */
      function _updateUI() {
        const remaining = AppState.timerRemaining;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

        const timeEl = document.getElementById('timer-time');
        if (timeEl) timeEl.textContent = timeStr;

        const modeLabels = {
          work:       'Deep Focus Session',
          shortBreak: 'Short Break',
          longBreak:  'Long Break'
        };
        const labelEl = document.getElementById('timer-mode-label');
        if (labelEl) labelEl.textContent = modeLabels[AppState.timerMode] || 'Deep Focus Session';

        // SVG ring
        const progress = getProgress();
        const ringEl = document.getElementById('timer-ring-progress');
        if (ringEl) {
          ringEl.style.strokeDashoffset = CIRCUMFERENCE * (1 - progress);
        }

        // Start/Pause button text
        const btnEl = document.getElementById('btn-start-pause');
        if (btnEl) {
          if (AppState.timerRunning) {
            btnEl.textContent = '-> Pause Session';
          } else {
            btnEl.textContent = AppState.timerRemaining < _totalDuration()
          ? 'Resume'
          : 'Start Session';
          }
        }
      }

      /** Internal tick -> called every 1000 ms */
      function _tick() {
        if (!AppState.timerRunning) return;

        AppState.timerRemaining = _clamp(AppState.timerRemaining - 1, 0, Infinity);

        _tickCallbacks.forEach(cb => cb(AppState.timerRemaining));
        _updateUI();

        if (AppState.timerRemaining <= 0) {
          _onComplete();
        }
      }

      /** Handle session completion */
      function _onComplete() {
        pause();

        const completedMode = AppState.timerMode;

        if (completedMode === 'work') {
          AppState.sessionsCompleted += 1;
          AppState.totalSessionsToday += 1;
          // Every 4th completed work session -> long break
          if (AppState.sessionsCompleted % 4 === 0) {
            AppState.timerMode = 'longBreak';
          } else {
            AppState.timerMode = 'shortBreak';
          }
        } else {
          // Break complete -> back to work
          AppState.timerMode = 'work';
        }

        AppState.timerRemaining = _totalDuration();
        StorageManager.save(AppState);

        _sessionCompleteCallbacks.forEach(cb => cb(completedMode));

        // Send browser notification
        if (completedMode === 'work') {
          NotificationManager.send('Session complete!', 'Time for a break.');
        } else {
          NotificationManager.send('Break over!', 'Ready to focus again?');
        }

        _updateUI();

        // Auto-start next session after 3 seconds
        _scheduleAutoStart(completedMode);
      }

      /** Schedule auto-start of next session after a brief delay */
      let _autoStartTimer = null;
      function _scheduleAutoStart(completedMode) {
        clearTimeout(_autoStartTimer);
        const nextLabel = completedMode === 'work'
          ? (AppState.timerMode === 'longBreak' ? 'long break' : 'short break')
          : 'work session';
        showToast(`Starting ${nextLabel} in 3 seconds...`);
        _autoStartTimer = setTimeout(() => {
          if (!AppState.timerRunning) {
            start();
          }
        }, 3000);
      }

      /** Start or resume the countdown */
      function start() {
        if (AppState.timerRunning) return;
        AppState.timerRunning = true;
        _intervalId = setInterval(_tick, 1000);
        _updateUI();
        StorageManager.save(AppState);
        // Play session-start chime when beginning a work session
        if (AppState.timerMode === 'work') {
          AudioEngine.playSessionStart();
          // Update streak on work session start, then check achievements
          StorageManager.updateStreak();
          if (typeof AchievementEngine !== 'undefined') {
            AchievementEngine.checkAll();
          }
        }
      }

      /** Pause the countdown */
      function pause() {
        if (!AppState.timerRunning) return;
        AppState.timerRunning = false;
        clearInterval(_intervalId);
        _intervalId = null;
        _updateUI();
        StorageManager.save(AppState);
      }

      /** Reset to the current mode's full duration */
      function reset() {
        pause();
        clearTimeout(_autoStartTimer);
        _autoStartTimer = null;
        AppState.timerRemaining = _totalDuration();
        _updateUI();
        StorageManager.save(AppState);
      }

      /** Skip to the next mode */
      function skip() {
        pause();
        const skippedMode = AppState.timerMode;
        if (skippedMode === 'work') {
          AppState.sessionsCompleted += 1;
          AppState.totalSessionsToday += 1;
          AppState.timerMode = AppState.sessionsCompleted % 4 === 0 ? 'longBreak' : 'shortBreak';
        } else {
          AppState.timerMode = 'work';
        }
        AppState.timerRemaining = _totalDuration();
        _sessionCompleteCallbacks.forEach(cb => cb(skippedMode));
        _updateUI();
        StorageManager.save(AppState);
      }

      /** Register a tick callback: cb(remaining: number) */
      function onTick(cb) {
        _tickCallbacks.push(cb);
      }

      /** Register a session-complete callback: cb(mode: string) */
      function onSessionComplete(cb) {
        _sessionCompleteCallbacks.push(cb);
      }

      /**
       * Returns progress as a value in [0.0, 1.0].
       * 0.0 = just started, 1.0 = complete.
       */
      function getProgress() {
        const total = _totalDuration();
        if (total <= 0) return 1;
        const raw = 1 - (AppState.timerRemaining / total);
        return Math.min(Math.max(raw, 0), 1);
      }

      return { start, pause, reset, skip, onTick, onSessionComplete, getProgress };
    })();

    /* =============================================
       BURNOUT ENGINE
       ============================================= */
    const BurnoutEngine = (() => {
      // Track whether we've already shown the urgent popup for the current
      // threshold crossing (reset when score drops below 80)
      let _urgentShown = false;

      /** Clamp a value to [0, 100] */
      function _clamp(val) {
        return Math.min(Math.max(val, 0), 100);
      }

      /** Shared mutation logic: apply delta, clamp, record history, persist, update UI */
      function _applyDelta(delta) {
        AppState.burnoutScore = _clamp(AppState.burnoutScore + delta);

        // Append timestamped history entry
        AppState.burnoutHistory.push({ timestamp: Date.now(), score: AppState.burnoutScore });

        // Urgent popup -> show once per threshold crossing
        if (AppState.burnoutScore >= 80) {
          if (!_urgentShown) {
            _urgentShown = true;
            _showUrgentPopup();
          }
        } else {
          // Score dropped below 80 -> reset flag so popup can fire again next crossing
          _urgentShown = false;
        }

        // Persist
        StorageManager.save(AppState);

        // Update gauge UI
        _updateGaugeUI();

        // Sync Milo's emotional state with the new burnout score
        if (typeof MiloController !== 'undefined') {
          MiloController.updateFromBurnout();
        }

        // Check achievements after every burnout mutation
        if (typeof AchievementEngine !== 'undefined') {
          AchievementEngine.checkAll();
        }
      }

      /** Increase burnout score by 10 (work session completed) */
      function addSession() {
        _applyDelta(10);
      }

      /** Decrease burnout score by 15 (break completed) */
      function completeBreak() {
        _applyDelta(-15);
      }

      /** Return current burnout score */
      function getScore() {
        return AppState.burnoutScore;
      }

      /**
       * Return Milo's emotional state based on current score:
       *   0->40   -> 'happy'
       *   41->70  -> 'tired'
       *   71->100 -> 'exhausted'
       */
      function getMiloState() {
        const score = AppState.burnoutScore;
        if (score <= 40) return 'happy';
        if (score <= 70) return 'tired';
        return 'exhausted';
      }

      /** Return true if score >= 80 */
      function checkUrgentThreshold() {
        return AppState.burnoutScore >= 80;
      }

      /* ---- UI helpers ---- */

      /** Derive gauge fill colour from score */
      function _gaugeColor(score) {
        if (score <= 40) return 'var(--burnout-low)';   // sage green
        if (score <= 70) return 'var(--burnout-mid)';   // warm tan
        if (score <= 80) return 'var(--burnout-high)';  // terracotta
        return 'var(--burnout-crit)';                   // deep red
      }

      /** Bar colour for weekly energy bars */
      function _barColor(score) {
        if (score <= 40) return 'var(--accent-sage)';
        if (score <= 70) return 'var(--accent-blush)';
        return 'var(--burnout-high)';
      }

      /** Update the burnout gauge fill and score value in the DOM */
      function _updateGaugeUI() {
        const score = AppState.burnoutScore;

        const fillEl = document.getElementById('burnout-gauge-fill');
        if (fillEl) {
          fillEl.style.width = `${score}%`;
          fillEl.style.backgroundColor = _gaugeColor(score);
        }

        const valueEl = document.getElementById('burnout-score-value');
        if (valueEl) valueEl.textContent = score;

        _renderEnergyBars();
      }

      /** Render Mon->Fri energy bars from the last 5 burnoutHistory entries */
      function _renderEnergyBars() {
        const container = document.getElementById('energy-bars');
        if (!container) return;

        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

        // Use last 5 history entries, or pad with zeros if fewer exist
        const history = AppState.burnoutHistory.slice(-5);
        while (history.length < 5) history.unshift({ score: 0 });

        container.innerHTML = '';
        history.forEach((entry, i) => {
          const score = entry.score;
          const heightPct = Math.max(score, 4); // min 4% so bar is always visible

          const col = document.createElement('div');
          col.className = 'energy-bar-col';

          const bar = document.createElement('div');
          bar.className = 'energy-bar';
          bar.style.height = `${heightPct}%`;
          bar.style.backgroundColor = _barColor(score);

          const label = document.createElement('div');
          label.className = 'energy-bar-label';
          label.textContent = days[i];

          col.appendChild(bar);
          col.appendChild(label);
          container.appendChild(col);
        });
      }

      /** Show the urgent burnout popup */
      function _showUrgentPopup() {
        const overlay = document.getElementById('urgent-popup-overlay');
        if (overlay) overlay.classList.add('urgent-popup-overlay--visible');
      }

      /** Hide the urgent burnout popup */
      function _hideUrgentPopup() {
        const overlay = document.getElementById('urgent-popup-overlay');
        if (overlay) overlay.classList.remove('urgent-popup-overlay--visible');
      }

      /** Wire popup dismiss buttons */
      function _wirePopupButtons() {
        const btnTakeBreak = document.getElementById('btn-urgent-take-break');
        const btnDismiss   = document.getElementById('btn-urgent-dismiss');

        if (btnTakeBreak) {
          btnTakeBreak.addEventListener('click', () => {
            _hideUrgentPopup();
            showToast('Time for a break!');
          });
        }

        if (btnDismiss) {
          btnDismiss.addEventListener('click', () => _hideUrgentPopup());
        }
      }

      return {
        addSession,
        completeBreak,
        getScore,
        getMiloState,
        checkUrgentThreshold,
        /** Call once during app init to wire popup buttons and render initial gauge */
        init() {
          _wirePopupButtons();
          _updateGaugeUI();
        }
      };
    })();

    /* =============================================
       AUDIO ENGINE
       ============================================= */
    const AudioEngine = (() => {
      let _ctx = null;
      let _enabled = true;
      let _pendingSound = null;

      /** Create (or resume) the AudioContext. Returns false if unavailable. */
      function _ensureContext() {
        if (!_ctx) {
          try {
            _ctx = new (window.AudioContext || window.webkitAudioContext)();
          } catch (e) {
            _enabled = false;
            return false;
          }
        }
        if (_ctx.state === 'suspended') {
          _ctx.resume();
        }
        return true;
      }

      /**
       * Play a single sine-wave tone with a quick attack/release envelope.
       * @param {number} freq      - Frequency in Hz
       * @param {number} startTime - AudioContext time to begin (seconds)
       * @param {number} duration  - Total duration in seconds (default 0.3)
       */
      function _playTone(freq, startTime, duration = 0.3) {
        if (!_ctx) return;
        const osc  = _ctx.createOscillator();
        const gain = _ctx.createGain();
        osc.connect(gain);
        gain.connect(_ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        // Envelope: silent -> peak at 0.05 s -> silent at end
        gain.gain.setValueAtTime(0, startTime);
        gain.gain.linearRampToValueAtTime(0.3, startTime + 0.05);
        gain.gain.linearRampToValueAtTime(0, startTime + duration);
        osc.start(startTime);
        osc.stop(startTime + duration + 0.05);
      }

      // Frequencies (Hz): C5=523, E5=659, G5=784
      /** Ascending 2-tone chime: C5 -> E5 */
      function playSessionStart() {
        if (!_enabled) return;
        if (!_ensureContext()) { _pendingSound = playSessionStart; return; }
        const t = _ctx.currentTime;
        _playTone(523, t);         // C5
        _playTone(659, t + 0.25);  // E5
      }

      /** Soft descending bell: G5 -> E5 */
      function playBreakStart() {
        if (!_enabled) return;
        if (!_ensureContext()) { _pendingSound = playBreakStart; return; }
        const t = _ctx.currentTime;
        _playTone(784, t);         // G5
        _playTone(659, t + 0.3);   // E5
      }

      /** 3-tone celebration melody: C5 -> E5 -> G5 */
      function playSessionEnd() {
        if (!_enabled) return;
        if (!_ensureContext()) { _pendingSound = playSessionEnd; return; }
        const t = _ctx.currentTime;
        _playTone(523, t);         // C5
        _playTone(659, t + 0.25);  // E5
        _playTone(784, t + 0.5);   // G5
      }

      /** Enable or disable all audio output */
      function setEnabled(val) {
        _enabled = !!val;
      }

      /**
       * Must be called on the first user interaction (click / keypress).
       * Creates the AudioContext and replays any sound that was queued before
       * the context was available.
       */
      function init() {
        _ensureContext();
        if (_pendingSound) {
          const fn = _pendingSound;
          _pendingSound = null;
          fn();
        }
      }

      return { playSessionStart, playBreakStart, playSessionEnd, setEnabled, init };
    })();

    /* =============================================
       TIMER BUTTON WIRING
       ============================================= */
    function _wireTimerButtons() {
      const btnStartPause = document.getElementById('btn-start-pause');
      const btnReset = document.getElementById('btn-reset');

      if (btnStartPause) {
        btnStartPause.addEventListener('click', () => {
          if (AppState.timerRunning) {
            TimerEngine.pause();
          } else {
            TimerEngine.start();
          }
        });
      }

      if (btnReset) {
        btnReset.addEventListener('click', () => TimerEngine.reset());
      }
    }

    /* =============================================
       SPACEBAR SHORTCUT
       ============================================= */
    document.addEventListener('keydown', e => {
      if (e.code !== 'Space') return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
      e.preventDefault();
      if (AppState.timerRunning) {
        TimerEngine.pause();
      } else {
        TimerEngine.start();
      }
    });

    /* =============================================
       MILO STATE CONTROLLER
       ============================================= */

    /**
     * Returns Milo's emotional state from a burnout score.
     *   0->40   -> 'happy'
     *   41->70  -> 'tired'
     *   71->100 -> 'exhausted'
     */
    function getMiloStateFromScore(score) {
      if (score <= 40) return 'happy';
      if (score <= 70) return 'tired';
      return 'exhausted';
    }

    const MiloController = {
      currentState: 'happy',
      _celebrateTimer: null,

      /** Derive state from current burnout score and transition */
      updateFromBurnout() {
        const state = getMiloStateFromScore(AppState.burnoutScore);
        this.transitionTo(state);
      },

      /** Transition Milo to a new state (won't interrupt an active celebration) */
      transitionTo(state) {
        if (this._celebrateTimer && state !== 'celebrating') return;
        this.currentState = state;
        const container = document.getElementById('milo-container');
        if (!container) return;
        container.className = `milo-container milo--${state}`;
        this._updateMiloName(state);
      },

      /** Trigger celebrating state for 3 s, then restore from burnout score */
      celebrate() {
        clearTimeout(this._celebrateTimer);
        this.transitionTo('celebrating');
        this._celebrateTimer = setTimeout(() => {
          this._celebrateTimer = null;
          this.updateFromBurnout();
        }, 3000);
      },

      _updateMiloName(state) {
        const nameEl = document.getElementById('milo-name');
        const names = {
          happy:       'Milo is focused',
          tired:       'Milo is tired',
          exhausted:   'Milo is exhausted',
          celebrating: 'Milo is celebrating!'
        };
        if (nameEl) nameEl.textContent = names[state] || 'Milo';
      }
    };

    /* =============================================
       SPEECH BUBBLE ROTATION
       ============================================= */
    const SPEECH_MESSAGES = {
      work:        [
        "Psst! Aku juga lagi fokus nih...",
        "Kamu hebat! Terus semangat ya!",
        "Timer lagi jalan, aku jagain kamu~"
      ],
      preBreak:    [
        "Udah 25 menit nih! Aku ngantuk... break yuk!",
        "Matamu lebih berharga dari deadlinemu!",
        "Ayo istirahat sebentar, nanti balik lagi lebih fresh!"
      ],
      hydration:   [
        "Aku baru minum susu~ kamu udah minum air belum?",
        "Tubuhmu 60% air loh! Jangan lupa minum!"
      ],
      highBurnout: [
        "Hei!! Aku khawatir sama kamu... istirahat dulu dong",
        "STOP! Kamu udah kerja terlalu lama. Milo minta tolong, break dulu!"
      ]
    };

    let _msgIndex = 0;

    function _getMessageCategory() {
      if (AppState.burnoutScore >= 70) return 'highBurnout';
      if (AppState.timerRemaining < 120 && AppState.timerMode === 'work') return 'preBreak';
      if (Math.random() < 0.2) return 'hydration';
      return 'work';
    }

    function rotateSpeechBubble() {
      const category = _getMessageCategory();
      const msgs = SPEECH_MESSAGES[category];
      _msgIndex = (_msgIndex + 1) % msgs.length;
      const bubble = document.getElementById('milo-speech-bubble');
      if (bubble) {
        bubble.style.opacity = '0';
        setTimeout(() => {
          const quoteEl = bubble.querySelector('.milo-quote');
          if (quoteEl) quoteEl.innerHTML = `<em>"${msgs[_msgIndex]}"</em>`;
          bubble.style.opacity = '1';
        }, 300);
      }
    }

    /* =============================================
       MANUAL FEELING CHECK-IN
       ============================================= */
    const FEELING_RESPONSES = {
      great: [
        "Purr~ You're on fire today! Keep that energy going, but don't forget to blink! ",
        "Amazing! Milo is so proud of you~ Maybe a quick eye break to protect those hardworking eyes? ",
        "You're doing great! A short stretch will keep you feeling this good even longer! "
      ],
      tired: [
        "Meow... Milo sees you're tired. A breathing break will help recharge your spirit~ ",
        "Time to rest those eyes and take a deep breath. You've earned it, paw-mise! ",
        "Milo recommends a 5-minute stretch  your body will thank you! "
      ],
      stressed: [
        "Hey, it's okay. Milo is here~ Try the breathing exercise, it really helps! ",
        "Purr purr... stress melts away with a gentle stretch. You've got this! ",
        "Take a hydration break  water clears the mind. Milo believes in you! "
      ],
      focused: [
        "Ooh, you're in the zone! A quick eye break will keep that focus sharp~ ",
        "Milo loves your focus energy! Protect it with a short stretch break! ",
        "You're locked in! Stay hydrated to keep that concentration going~ "
      ]
    };

    function _getMiloResponse(feeling) {
      const responses = FEELING_RESPONSES[feeling] || FEELING_RESPONSES.great;
      return responses[Math.floor(Math.random() * responses.length)];
    }

    function showFeelingCheckIn() {
      const overlay = document.getElementById('feeling-modal-overlay');
      const countEl = document.getElementById('feeling-session-count');
      if (!overlay) return;

      if (countEl) countEl.textContent = AppState.sessionsCompleted;
      overlay.classList.add('feeling-modal-overlay--visible');

      const buttons = overlay.querySelectorAll('.feeling-btn');
      buttons.forEach(btn => {
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.addEventListener('click', () => {
          const feelingState = fresh.dataset.feeling;
          overlay.classList.remove('feeling-modal-overlay--visible');

          const response = _getMiloResponse(feelingState);

          const bubble = document.getElementById('milo-speech-bubble');
          const quoteEl = bubble ? bubble.querySelector('.milo-quote') : null;
          if (quoteEl) {
            bubble.style.opacity = '0';
            setTimeout(() => {
              quoteEl.innerHTML = `<em>"${response}"</em>`;
              bubble.style.opacity = '1';
            }, 200);
          }
        });
      });
    }

    /* =============================================
       ACHIEVEMENT META
       ============================================= */
    const ACHIEVEMENT_META = {
      hydrationHero:   { emoji: '', title: 'Hydration Hero',   desc: 'Logged 8 glasses in one day' },
      sevenDayWarrior: { emoji: '', title: '7-Day Warrior',    desc: '7-day streak achieved!' },
      eyeProtector:    { emoji: '', title: 'Eye Protector',    desc: 'Completed 5 eye breaks' },
      burnoutBuster:   { emoji: '', title: 'Burnout Buster',   desc: 'Dropped burnout from 80 to below 30' },
      stretchMaster:   { emoji: '', title: 'Stretch Master',   desc: 'Completed 10 stretch breaks' }
    };

    /* =============================================
       CONFETTI ANIMATION
       ============================================= */
    function triggerConfetti() {
      const colors = ['#8A9070', '#D4B8A0', '#C47A5A', '#5B8A8A', '#F4A460', '#FFB6C1'];
      for (let i = 0; i < 40; i++) {
        const piece = document.createElement('div');
        piece.className = 'confetti-piece';
        piece.style.cssText = `
          left: ${Math.random() * 100}vw;
          background: ${colors[Math.floor(Math.random() * colors.length)]};
          animation-delay: ${Math.random() * 0.5}s;
          animation-duration: ${1 + Math.random() * 1}s;
          width: ${6 + Math.random() * 6}px;
          height: ${6 + Math.random() * 6}px;
          border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
        `;
        document.body.appendChild(piece);
        setTimeout(() => piece.remove(), 2000);
      }
    }

    /* =============================================
       ACHIEVEMENT NOTIFICATION
       ============================================= */
    function showAchievementNotification(meta) {
      const container = document.getElementById('toast-container');
      const notif = document.createElement('div');
      notif.className = 'achievement-notif';
      notif.innerHTML = `
        <span class="achievement-notif__emoji">${meta.emoji}</span>
        <div>
          <div class="achievement-notif__title">${meta.title}</div>
          <div class="achievement-notif__desc">${meta.desc}</div>
        </div>
      `;
      container.appendChild(notif);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => notif.classList.add('achievement-notif--visible'));
      });

      setTimeout(() => {
        notif.classList.remove('achievement-notif--visible');
        setTimeout(() => notif.remove(), 400);
      }, 4000);
    }

    /* =============================================
       ACHIEVEMENT ENGINE
       ============================================= */
    const AchievementEngine = {
      checkAll() {
        const unlocked = [];

        // Hydration Hero
        if (AppState.waterIntakeToday >= AppState.settings.dailyWaterGoal && !AppState.achievements.hydrationHero) {
          AppState.achievements.hydrationHero = true;
          unlocked.push('hydrationHero');
        }

        // 7-Day Warrior
        if (AppState.streakDays >= 7 && !AppState.achievements.sevenDayWarrior) {
          AppState.achievements.sevenDayWarrior = true;
          unlocked.push('sevenDayWarrior');
        }

        // Eye Protector
        if (AppState.achievements.eyeProtector >= 5 && !AppState.achievements.eyeProtectorUnlocked) {
          AppState.achievements.eyeProtectorUnlocked = true;
          unlocked.push('eyeProtector');
        }

        // Burnout Buster -> track when score was >= 80
        if (AppState.burnoutScore >= 80) {
          AppState.achievements.burnoutBusterPrevHigh = true;
        }
        if (AppState.achievements.burnoutBusterPrevHigh && AppState.burnoutScore < 30 && !AppState.achievements.burnoutBuster) {
          AppState.achievements.burnoutBuster = true;
          unlocked.push('burnoutBuster');
        }

        // Stretch Master
        if (AppState.achievements.stretchMaster >= 10 && !AppState.achievements.stretchMasterUnlocked) {
          AppState.achievements.stretchMasterUnlocked = true;
          unlocked.push('stretchMaster');
        }

        if (unlocked.length > 0) {
          StorageManager.save(AppState);
          unlocked.forEach(badge => this._onUnlock(badge));
        }

        return unlocked;
      },

      _onUnlock(badge) {
        const meta = ACHIEVEMENT_META[badge];
        if (!meta) return;
        showAchievementNotification(meta);
        triggerConfetti();
        MiloController.celebrate();
      }
    };

    /* =============================================
       WATER INTAKE HELPER
       ============================================= */
    function incrementWaterIntake() {
      AppState.waterIntakeToday += 1;
      AchievementEngine.checkAll();
      StorageManager.save(AppState);
    }

    /* =============================================
       HISTORY PAGE -> renderHistoryPage()
       ============================================= */
    // Chart instances (lazy-init, destroyed on re-render)
    let _burnoutChartInstance = null;
    let _breakDistChartInstance = null;

    function renderHistoryPage() {
      // --- Stat cards ---
      const focusHours = ((AppState.totalSessionsToday * AppState.settings.workDuration) / 60).toFixed(1);
      const totalBreaks = AppState.breakHistory.length;
      const hydrationL = (AppState.waterIntakeToday * 0.25).toFixed(2);
      const hydrationGoalL = AppState.settings.dailyWaterGoal * 0.25;
      const hydrationPct = hydrationGoalL > 0
        ? Math.round((AppState.waterIntakeToday / AppState.settings.dailyWaterGoal) * 100)
        : 0;

      const el = id => document.getElementById(id);
      if (el('stat-focus-hours'))   el('stat-focus-hours').textContent   = focusHours + 'h';
      if (el('stat-focus-delta'))   el('stat-focus-delta').textContent   = 'Today';
      if (el('stat-total-breaks'))  el('stat-total-breaks').textContent  = totalBreaks;
      if (el('stat-hydration'))     el('stat-hydration').textContent     = hydrationL + 'L';
      if (el('stat-hydration-pct')) el('stat-hydration-pct').textContent = hydrationPct + '% of daily goal';

      // --- Burnout Trends bar chart (last 7 burnoutHistory entries) ---
      const burnoutCanvas = el('burnout-chart');
      if (burnoutCanvas) {
        const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
        const history7 = AppState.burnoutHistory.slice(-7);
        while (history7.length < 7) history7.unshift({ score: 0 });
        const scores = history7.map(e => e.score);

        if (_burnoutChartInstance) {
          _burnoutChartInstance.destroy();
          _burnoutChartInstance = null;
        }
        _burnoutChartInstance = new Chart(burnoutCanvas, {
          type: 'bar',
          data: {
            labels: dayLabels,
            datasets: [{
              data: scores,
              backgroundColor: scores.map(s =>
                s <= 40 ? 'rgba(138,144,112,0.7)' :
                s <= 70 ? 'rgba(212,184,160,0.7)' :
                          'rgba(196,122,90,0.7)'
              ),
              borderRadius: 6,
              borderSkipped: false
            }]
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              y: { min: 0, max: 100, grid: { color: 'rgba(44,42,36,0.06)' }, ticks: { color: '#9C9A94', font: { size: 11 } } },
              x: { grid: { display: false }, ticks: { color: '#9C9A94', font: { size: 11 } } }
            }
          }
        });
      }

      // --- Break Distribution donut chart ---
      const distCanvas = el('break-dist-chart');
      if (distCanvas) {
        const counts = { eye: 0, hydration: 0, stretch: 0, breathing: 0 };
        AppState.breakHistory.forEach(b => { if (counts[b.type] !== undefined) counts[b.type]++; });
        const total = Object.values(counts).reduce((a, b) => a + b, 0);

        const distTotalEl = el('break-dist-total');
        if (distTotalEl) distTotalEl.innerHTML = `${total}<br><span>total</span>`;

        const labels = ['Eye Care', 'Hydration', 'Stretch', 'Breathing'];
        const data   = [counts.eye, counts.hydration, counts.stretch, counts.breathing];
        const colors = ['#8A9070', '#5B8A8A', '#D4B8A0', '#C47A5A'];

        if (_breakDistChartInstance) {
          _breakDistChartInstance.destroy();
          _breakDistChartInstance = null;
        }
        _breakDistChartInstance = new Chart(distCanvas, {
          type: 'doughnut',
          data: {
            labels,
            datasets: [{
              data: total > 0 ? data : [1, 1, 1, 1],
              backgroundColor: colors,
              borderWidth: 0,
              hoverOffset: 4
            }]
          },
          options: {
            cutout: '65%',
            responsive: false,
            plugins: { legend: { display: false }, tooltip: { enabled: total > 0 } }
          }
        });

        // Legend
        const legendEl = el('break-dist-legend');
        if (legendEl) {
          legendEl.innerHTML = labels.map((lbl, i) => {
            const pct = total > 0 ? Math.round((data[i] / total) * 100) : 0;
            return `<div class="break-dist-legend-item">
              <span><span class="break-dist-legend-dot" style="background:${colors[i]}"></span>${lbl}</span>
              <span>${data[i]} (${pct}%)</span>
            </div>`;
          }).join('');
        }
      }

      // --- Session Chronicles table (last 10 sessionHistory entries) ---
      const tableEl = el('chronicles-table');
      if (tableEl) {
        const rows = (AppState.sessionHistory || []).slice(-10).reverse();
        if (rows.length === 0) {
          tableEl.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:0.875rem;">No sessions recorded yet.</div>';
        } else {
          tableEl.innerHTML = rows.map(row => {
            const date = new Date(row.completedAt || Date.now());
            const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
            const duration = row.duration || AppState.settings.workDuration;
            const status = row.status || 'standard';
            const badgeClass = status === 'optimized' ? 'chronicles-badge--optimized'
                             : status === 'flow'      ? 'chronicles-badge--flow'
                             :                          'chronicles-badge--standard';
            const badgeLabel = status === 'optimized' ? 'Optimized'
                             : status === 'flow'      ? 'Flow State'
                             :                          'Standard';
            const activity = row.activityType || AppState.activityType || 'coding';
            const activityLabel = activity.charAt(0).toUpperCase() + activity.slice(1);
            return `<div class="chronicles-row">
              <span class="chronicles-row__date">${dateStr} ${timeStr}</span>
              <span class="chronicles-row__activity">${activityLabel}</span>
              <span class="chronicles-row__duration">${duration}m</span>
              <span class="chronicles-badge ${badgeClass}">${badgeLabel}</span>
            </div>`;
          }).join('');
        }
      }

      // --- Export CSV button ---
      const csvBtn = el('btn-export-csv');
      if (csvBtn) {
        // Remove previous listener by cloning
        const freshCsv = csvBtn.cloneNode(true);
        csvBtn.parentNode.replaceChild(freshCsv, csvBtn);
        freshCsv.addEventListener('click', () => {
          const sessions = AppState.sessionHistory || [];
          if (sessions.length === 0) { showToast('No sessions to export.'); return; }
          const header = 'Date,Activity,Duration (min),Status';
          const csvRows = sessions.map(row => {
            const d = new Date(row.completedAt || 0).toISOString();
            const act = row.activityType || AppState.activityType || 'coding';
            const dur = row.duration || AppState.settings.workDuration;
            const st  = row.status || 'standard';
            return `${d},${act},${dur},${st}`;
          });
          const blob = new Blob([[header, ...csvRows].join('\n')], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'mindfulbreak-sessions.csv';
          a.click();
          URL.revokeObjectURL(url);
        });
      }

      // --- Load more button (no-op placeholder) ---
      const loadMoreBtn = el('btn-load-more');
      if (loadMoreBtn) {
        const freshLM = loadMoreBtn.cloneNode(true);
        loadMoreBtn.parentNode.replaceChild(freshLM, loadMoreBtn);
        freshLM.addEventListener('click', () => showToast('All entries loaded.'));
      }
    }

    /* =============================================
       SETTINGS PAGE -> initSettingsPage()
       ============================================= */
    // Tracks the pending water goal value before save
    let _pendingWaterGoal = 8;

    function initSettingsPage() {
      const s = AppState.settings;
      const el = id => document.getElementById(id);

      // --- Sliders ---
      const sliderWork    = el('slider-work');
      const sliderShort   = el('slider-short');
      const sliderLong    = el('slider-long');
      const sliderBurnout = el('slider-burnout');

      if (sliderWork) {
        sliderWork.value = s.workDuration;
        el('val-work').textContent = s.workDuration + ' min';
        sliderWork.oninput = () => { el('val-work').textContent = sliderWork.value + ' min'; };
      }
      if (sliderShort) {
        sliderShort.value = s.shortBreakDuration;
        el('val-short').textContent = s.shortBreakDuration + ' min';
        sliderShort.oninput = () => { el('val-short').textContent = sliderShort.value + ' min'; };
      }
      if (sliderLong) {
        sliderLong.value = s.longBreakDuration;
        el('val-long').textContent = s.longBreakDuration + ' min';
        sliderLong.oninput = () => { el('val-long').textContent = sliderLong.value + ' min'; };
      }
      if (sliderBurnout) {
        sliderBurnout.value = s.burnoutThreshold || 80;
        el('val-burnout').textContent = s.burnoutThreshold || 80;
        sliderBurnout.oninput = () => { el('val-burnout').textContent = sliderBurnout.value; };
      }

      // --- Session type buttons ---
      const typeGrid = el('session-type-grid');
      if (typeGrid) {
        typeGrid.querySelectorAll('.session-type-btn').forEach(btn => {
          btn.classList.toggle('session-type-btn--active', btn.dataset.type === AppState.activityType);
          btn.onclick = () => {
            typeGrid.querySelectorAll('.session-type-btn').forEach(b => b.classList.remove('session-type-btn--active'));
            btn.classList.add('session-type-btn--active');
          };
        });
      }

      // --- Water goal stepper ---
      _pendingWaterGoal = s.dailyWaterGoal;
      const waterValEl = el('val-water-goal');
      if (waterValEl) waterValEl.textContent = _pendingWaterGoal;

      const btnMinus = el('btn-water-minus');
      const btnPlus  = el('btn-water-plus');
      if (btnMinus) {
        btnMinus.onclick = () => {
          if (_pendingWaterGoal > 1) { _pendingWaterGoal--; if (waterValEl) waterValEl.textContent = _pendingWaterGoal; }
        };
      }
      if (btnPlus) {
        btnPlus.onclick = () => {
          if (_pendingWaterGoal < 20) { _pendingWaterGoal++; if (waterValEl) waterValEl.textContent = _pendingWaterGoal; }
        };
      }

      // --- Toggles ---
      const toggleNotif  = el('toggle-notifications');
      const toggleSound  = el('toggle-sound');
      if (toggleNotif) toggleNotif.checked = s.notificationsEnabled;
      if (toggleSound)  toggleSound.checked  = s.soundEnabled;

      // --- Milo theme buttons ---
      const themeGrid = el('milo-theme-grid');
      if (themeGrid) {
        themeGrid.querySelectorAll('.milo-theme-btn').forEach(btn => {
          btn.classList.toggle('milo-theme-btn--active', btn.dataset.theme === AppState.miloColorTheme);
          btn.onclick = () => {
            themeGrid.querySelectorAll('.milo-theme-btn').forEach(b => b.classList.remove('milo-theme-btn--active'));
            btn.classList.add('milo-theme-btn--active');
            // Apply immediately
            document.documentElement.setAttribute('data-milo-theme', btn.dataset.theme);
          };
        });
      }

      // --- Save button ---
      const saveBtn = el('btn-save-settings');
      if (saveBtn) {
        const freshSave = saveBtn.cloneNode(true);
        saveBtn.parentNode.replaceChild(freshSave, saveBtn);
        freshSave.addEventListener('click', () => {
          // Read values
          const newWork    = parseInt(el('slider-work')?.value    || s.workDuration, 10);
          const newShort   = parseInt(el('slider-short')?.value   || s.shortBreakDuration, 10);
          const newLong    = parseInt(el('slider-long')?.value    || s.longBreakDuration, 10);
          const newBurnout = parseInt(el('slider-burnout')?.value || s.burnoutThreshold || 80, 10);
          const newNotif   = el('toggle-notifications')?.checked ?? s.notificationsEnabled;
          const newSound   = el('toggle-sound')?.checked          ?? s.soundEnabled;

          // Active session type
          const activeTypeBtn = el('session-type-grid')?.querySelector('.session-type-btn--active');
          const newType = activeTypeBtn ? activeTypeBtn.dataset.type : AppState.activityType;

          // Active milo theme
          const activeThemeBtn = el('milo-theme-grid')?.querySelector('.milo-theme-btn--active');
          const newTheme = activeThemeBtn ? activeThemeBtn.dataset.theme : AppState.miloColorTheme;

          // Apply to AppState
          AppState.settings.workDuration        = newWork;
          AppState.settings.shortBreakDuration  = newShort;
          AppState.settings.longBreakDuration   = newLong;
          AppState.settings.burnoutThreshold    = newBurnout;
          AppState.settings.notificationsEnabled = newNotif;
          AppState.settings.soundEnabled        = newSound;
          AppState.settings.dailyWaterGoal      = _pendingWaterGoal;
          AppState.activityType                 = newType;
          AppState.miloColorTheme               = newTheme;

          // Apply theme
          document.documentElement.setAttribute('data-milo-theme', newTheme);

          // Update mode badge
          const modeBadge = document.getElementById('mode-badge');
          if (modeBadge) {
            const labels = { coding: 'Coding Mode', writing: 'Writing Mode', studying: 'Study Mode', design: 'Design Mode' };
            modeBadge.textContent = labels[newType] || 'Coding Mode';
          }

          // Sync audio
          AudioEngine.setEnabled(newSound);

          // Persist
          StorageManager.save(AppState);
          showToast('Preferences saved!');
        });
      }

      // --- Discard button ---
      const discardBtn = el('btn-discard-settings');
      if (discardBtn) {
        const freshDiscard = discardBtn.cloneNode(true);
        discardBtn.parentNode.replaceChild(freshDiscard, discardBtn);
        freshDiscard.addEventListener('click', () => initSettingsPage());
      }

      // --- Export data ---
      const exportBtn = el('btn-export-data');
      if (exportBtn) {
        const freshExport = exportBtn.cloneNode(true);
        exportBtn.parentNode.replaceChild(freshExport, exportBtn);
        freshExport.addEventListener('click', () => {
          const blob = new Blob([JSON.stringify(AppState, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'mindfulbreak-data.json';
          a.click();
          URL.revokeObjectURL(url);
        });
      }

      // --- Reset stats ---
      const resetBtn = el('btn-reset-stats');
      if (resetBtn) {
        const freshReset = resetBtn.cloneNode(true);
        resetBtn.parentNode.replaceChild(freshReset, resetBtn);
        freshReset.addEventListener('click', () => {
          if (confirm('Reset all statistics? This cannot be undone.')) {
            StorageManager.reset();
            AppState = JSON.parse(JSON.stringify(DEFAULT_STATE));
            StorageManager.save(AppState);
            showToast('Statistics reset.');
            initSettingsPage();
          }
        });
      }

      // --- Delete account ---
      const deleteBtn = el('btn-delete-account');
      if (deleteBtn) {
        const freshDelete = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(freshDelete, deleteBtn);
        freshDelete.addEventListener('click', () => {
          if (confirm('Delete all data permanently? This cannot be undone.')) {
            StorageManager.reset();
            AppState = JSON.parse(JSON.stringify(DEFAULT_STATE));
            showToast('All data deleted.');
            showPage('landing');
          }
        });
      }
    }

    /* =============================================
       NOTIFICATION MANAGER
       ============================================= */
    const NotificationManager = {
      _permitted: false,

      async requestPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'granted') {
          this._permitted = true;
          return;
        }
        if (Notification.permission !== 'denied') {
          const result = await Notification.requestPermission();
          this._permitted = result === 'granted';
        }
        // If denied, silently disable the toggle in settings
        if (!this._permitted) {
          AppState.settings.notificationsEnabled = false;
          const toggle = document.getElementById('toggle-notifications');
          if (toggle) toggle.checked = false;
        }
      },

      send(title, body = '') {
        if (!this._permitted || !AppState.settings.notificationsEnabled) return;
        if (document.visibilityState === 'visible') return; // only when tab is hidden
        try {
          new Notification(title, { body, icon: '' });
        } catch (e) { /* ignore */ }
      }
    };

    /* =============================================
       ONBOARDING -> initOnboarding()
       ============================================= */
    function initOnboarding() {
      // Track selected activity
      let selectedActivity = AppState.activityType || 'coding';

      // Pre-select the current activity
      document.querySelectorAll('.activity-card').forEach(card => {
        card.classList.toggle('activity-card--selected', card.dataset.type === selectedActivity);
        card.addEventListener('click', () => {
          document.querySelectorAll('.activity-card').forEach(c => c.classList.remove('activity-card--selected'));
          card.classList.add('activity-card--selected');
          selectedActivity = card.dataset.type;
        });
      });

      // Step 1 -> Step 2
      const btn1 = document.getElementById('btn-landing-next-1');
      if (btn1) {
        btn1.addEventListener('click', () => {
          AppState.activityType = selectedActivity;
          document.getElementById('landing-step-1').style.display = 'none';
          document.getElementById('landing-step-2').style.display = 'flex';
        });
      }

      // Onboarding sliders
      const sliderWork  = document.getElementById('onboard-slider-work');
      const sliderShort = document.getElementById('onboard-slider-short');
      const sliderLong  = document.getElementById('onboard-slider-long');
      if (sliderWork)  sliderWork.oninput  = () => { document.getElementById('onboard-val-work').textContent  = sliderWork.value  + ' min'; };
      if (sliderShort) sliderShort.oninput = () => { document.getElementById('onboard-val-short').textContent = sliderShort.value + ' min'; };
      if (sliderLong)  sliderLong.oninput  = () => { document.getElementById('onboard-val-long').textContent  = sliderLong.value  + ' min'; };

      // Step 2 -> Step 3
      const btn2 = document.getElementById('btn-landing-next-2');
      if (btn2) {
        btn2.addEventListener('click', () => {
          // Save timer preferences
          if (sliderWork)  AppState.settings.workDuration       = parseInt(sliderWork.value, 10);
          if (sliderShort) AppState.settings.shortBreakDuration = parseInt(sliderShort.value, 10);
          if (sliderLong)  AppState.settings.longBreakDuration  = parseInt(sliderLong.value, 10);
          document.getElementById('landing-step-2').style.display = 'none';
          document.getElementById('landing-step-3').style.display = 'flex';
        });
      }

      // Step 3 -> Main app
      const btnFinish = document.getElementById('btn-landing-finish');
      if (btnFinish) {
        btnFinish.addEventListener('click', () => {
          AppState.onboardingComplete = true;
          StorageManager.save(AppState);
          triggerConfetti();
          MiloController.celebrate();
          // Update mode badge
          const modeBadge = document.getElementById('mode-badge');
          if (modeBadge) {
            const labels = { coding: 'Coding Mode', writing: 'Writing Mode', studying: 'Study Mode', design: 'Design Mode' };
            modeBadge.textContent = labels[AppState.activityType] || 'Coding Mode';
          }
          // Update speech bubble
          const bubble = document.getElementById('milo-speech-bubble');
          const quoteEl = bubble ? bubble.querySelector('.milo-quote') : null;
          if (quoteEl) quoteEl.innerHTML = '<em>"Let\'s get to work! I\'ll keep you healthy~ "</em>';
          showPage('dashboard');
          TimerEngine.reset();
        });
      }
    }

    /* =============================================
       APP INITIALISATION
       ============================================= */
    function initApp() {
      // Initialise AudioContext on first user gesture (browsers block it before)
      const _audioInitHandler = () => {
        AudioEngine.init();
        document.removeEventListener('click',   _audioInitHandler);
        document.removeEventListener('keypress', _audioInitHandler);
      };
      document.addEventListener('click',   _audioInitHandler, { once: true });
      document.addEventListener('keypress', _audioInitHandler, { once: true });

      // Attempt to load persisted state
      const saved = StorageManager.load();

      if (saved) {
        // Merge saved state over defaults to handle schema additions gracefully
        AppState = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), saved);
        // Ensure nested objects are also merged
        AppState.settings = Object.assign(
          JSON.parse(JSON.stringify(DEFAULT_STATE.settings)),
          saved.settings || {}
        );
        AppState.achievements = Object.assign(
          JSON.parse(JSON.stringify(DEFAULT_STATE.achievements)),
          saved.achievements || {}
        );
      }

      // Apply Milo color theme
      document.documentElement.setAttribute('data-milo-theme', AppState.miloColorTheme || 'orange');
      // Update mode badge
      const modeBadge = document.getElementById('mode-badge');
      if (modeBadge) {
        const labels = {
          coding: 'Coding Mode',
          writing: 'Writing Mode',
          studying: 'Study Mode',
          design: 'Design Mode'
        };
        modeBadge.textContent = labels[AppState.activityType] || 'Coding Mode';
      }

      // Route to correct page
      if (AppState.onboardingComplete) {
        showPage('dashboard');
      } else {
        showPage('landing');
      }

      // Wire timer buttons and initialise display
      _wireTimerButtons();
      TimerEngine.reset();

      // Initialise BurnoutEngine (popup buttons + initial gauge render)
      BurnoutEngine.init();

      // Initialise Settings page (populate from AppState)
      initSettingsPage();

      // Initialise onboarding flow
      initOnboarding();

      // Request notification permission
      NotificationManager.requestPermission();

      // Set initial Milo state from loaded burnout score
      MiloController.updateFromBurnout();

      // Sync AudioEngine with sound setting
      AudioEngine.setEnabled(AppState.settings.soundEnabled);

      // Start speech bubble rotation (every 30 s)
      setInterval(rotateSpeechBubble, 30000);

      // Wire BurnoutEngine to TimerEngine: add session on every completed work session
      TimerEngine.onSessionComplete((mode) => {
        if (mode === 'work') {
          BurnoutEngine.addSession();
          // Record session history
          AppState.sessionHistory.push({
            completedAt: Date.now(),
            activityType: AppState.activityType,
            duration: AppState.settings.workDuration,
            status: AppState.burnoutScore < 30 ? 'flow' : AppState.burnoutScore < 60 ? 'optimized' : 'standard'
          });
          // Every 3rd completed work session -> show feeling check-in
          if (AppState.sessionsCompleted % 3 === 0) {
            showFeelingCheckIn();
          }
          // Switching to a break -> play break-start chime
          AudioEngine.playBreakStart();
        } else {
          // Break completed -> celebrate, reduce burnout, play session-end melody
          BurnoutEngine.completeBreak();
          MiloController.celebrate();
          AudioEngine.playSessionEnd();
        }
      });

      // Wire nurture cards to navigate to guided-breaks page
      document.querySelectorAll('.nurture-card').forEach(card => {
        card.addEventListener('click', () => showPage('guided-breaks'));
      });

      // Render initial dashboard session progress
      renderDashboardSessionProgress();
    }

    // Boot
    initApp();

    /* =============================================
       DASHBOARD SESSION PROGRESS RENDERER
       ============================================= */
    function renderDashboardSessionProgress() {
      const totalSessions = AppState.settings.sessionCount || 4;
      const completed = AppState.sessionsCompleted || 0;

      // Update count text
      const countEl = document.getElementById('dashboard-session-count');
      if (countEl) countEl.textContent = `${completed} / ${totalSessions}`;

      // Render dots
      const dotsEl = document.getElementById('dashboard-session-dots');
      if (dotsEl) {
        dotsEl.innerHTML = '';
        for (let i = 0; i < totalSessions; i++) {
          const dot = document.createElement('div');
          dot.className = 'session-progress-dot';

          if (i < completed) {
            dot.classList.add('session-progress-dot--completed');
            // checkmark is handled via CSS ::after
          } else if (i === completed) {
            dot.classList.add('session-progress-dot--current');
            dot.textContent = i + 1;
          } else {
            dot.classList.add('session-progress-dot--pending');
            dot.textContent = i + 1;
          }
          dotsEl.appendChild(dot);
        }
      }

      // Update progress bar
      const barEl = document.getElementById('dashboard-session-bar');
      if (barEl) {
        const pct = totalSessions > 0 ? Math.min((completed / totalSessions) * 100, 100) : 0;
        barEl.style.width = pct + '%';
      }
    }

    // Update dashboard progress on session complete
    TimerEngine.onSessionComplete((mode) => {
      if (mode === 'work') renderDashboardSessionProgress();
    });


/* =============================================
   FOCUS GROWTH HEATMAP RENDERER
   ============================================= */
function renderFocusGrowthHeatmap() {
  const graphEl = document.getElementById('focus-growth-graph');
  const monthsEl = document.getElementById('focus-growth-months');
  if (!graphEl) return;

  // Initialize or load focus growth data
  if (!AppState.focusGrowthData) AppState.focusGrowthData = {};

  // Record today's data
  const today = new Date();
  const todayKey = today.toISOString().split('T')[0];
  AppState.focusGrowthData[todayKey] = AppState.totalSessionsToday || 0;
  StorageManager.save(AppState);

  // Current year boundaries
  const currentYear = today.getFullYear();
  const jan1 = new Date(currentYear, 0, 1);
  const dec31 = new Date(currentYear, 11, 31);

  // Pad start to the Sunday before (or on) Jan 1
  const startPad = jan1.getDay(); // 0=Sun already, else pad back
  const startDate = new Date(jan1);
  startDate.setDate(startDate.getDate() - startPad);

  // Pad end to the Saturday after (or on) Dec 31
  const endPad = (6 - dec31.getDay()); // 6=Sat already, else pad forward
  const endDate = new Date(dec31);
  endDate.setDate(endDate.getDate() + endPad);

  // Total days in padded range
  const totalDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  // Find max sessions in any day for normalization
  const allValues = Object.values(AppState.focusGrowthData);
  const maxSessions = Math.max(1, ...allValues);

  // Clear
  graphEl.innerHTML = '';
  if (monthsEl) monthsEl.innerHTML = '';

  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const monthPositions = {};

  for (let i = 0; i < totalDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split('T')[0];
    const sessions = AppState.focusGrowthData[key] || 0;

    // Calculate level (0-4)
    let level = 0;
    if (sessions > 0) {
      const ratio = sessions / maxSessions;
      if (ratio <= 0.25) level = 1;
      else if (ratio <= 0.5) level = 2;
      else if (ratio <= 0.75) level = 3;
      else level = 4;
    }

    // Future dates stay at level 0
    if (d > today) level = 0;

    const cell = document.createElement('div');
    cell.className = 'focus-growth-cell';
    cell.setAttribute('data-level', level);

    // Tooltip
    const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const sessionStr = sessions === 0 ? 'No sessions' : sessions + (sessions === 1 ? ' session' : ' sessions');
    cell.setAttribute('data-tooltip', `${sessionStr} on ${dateStr}`);

    graphEl.appendChild(cell);

    // Track first Sunday of each month for label positions
    const weekIdx = Math.floor(i / 7);
    if (d.getFullYear() === currentYear) {
      const monthKey = d.getMonth();
      if (d.getDay() === 0 && !monthPositions[monthKey]) {
        monthPositions[monthKey] = { name: MONTH_NAMES[monthKey], week: weekIdx };
      }
    }
  }

  // Render month labels (JAN through DEC)
  if (monthsEl) {
    const totalWeeks = Math.ceil(totalDays / 7);
    const sortedMonths = Object.entries(monthPositions)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(e => e[1]);

    sortedMonths.forEach((m, idx) => {
      const label = document.createElement('span');
      label.className = 'focus-growth-month-label';
      label.textContent = m.name;

      const nextWeek = (idx < sortedMonths.length - 1) ? sortedMonths[idx + 1].week : totalWeeks;
      const span = nextWeek - m.week;
      label.style.flex = span;

      monthsEl.appendChild(label);
    });
  }
}

// Render heatmap on init and when sessions complete
renderFocusGrowthHeatmap();

// Floating tooltip for heatmap cells (avoids overflow clipping)
(function initHeatmapTooltip() {
  const section = document.querySelector('.focus-growth-section');
  const graph = document.getElementById('focus-growth-graph');
  const tooltip = document.getElementById('focus-growth-tooltip');
  if (!section || !graph || !tooltip) return;

  graph.addEventListener('mouseenter', function(e) {
    if (!e.target.classList.contains('focus-growth-cell')) return;
    const text = e.target.getAttribute('data-tooltip');
    if (!text) return;
    tooltip.textContent = text;
    tooltip.classList.add('visible');

    const sectionRect = section.getBoundingClientRect();
    const cellRect = e.target.getBoundingClientRect();
    tooltip.style.left = (cellRect.left + cellRect.width / 2 - sectionRect.left) + 'px';
    tooltip.style.top = (cellRect.top - sectionRect.top - 32) + 'px';
  }, true);

  graph.addEventListener('mouseleave', function(e) {
    if (e.target.classList.contains('focus-growth-cell')) {
      tooltip.classList.remove('visible');
    }
  }, true);

  graph.addEventListener('mouseover', function(e) {
    if (!e.target.classList.contains('focus-growth-cell')) {
      tooltip.classList.remove('visible');
      return;
    }
    const text = e.target.getAttribute('data-tooltip');
    if (!text) return;
    tooltip.textContent = text;
    tooltip.classList.add('visible');

    const sectionRect = section.getBoundingClientRect();
    const cellRect = e.target.getBoundingClientRect();
    tooltip.style.left = (cellRect.left + cellRect.width / 2 - sectionRect.left) + 'px';
    tooltip.style.top = (cellRect.top - sectionRect.top - 32) + 'px';
  });

  graph.addEventListener('mouseout', function(e) {
    if (e.target.classList.contains('focus-growth-cell')) {
      const related = e.relatedTarget;
      if (!related || !related.classList.contains('focus-growth-cell')) {
        tooltip.classList.remove('visible');
      }
    }
  });
})();

TimerEngine.onSessionComplete((mode) => {
  if (mode === 'work') {
    // Update today's data
    const todayKey = new Date().toISOString().split('T')[0];
    AppState.focusGrowthData = AppState.focusGrowthData || {};
    AppState.focusGrowthData[todayKey] = AppState.totalSessionsToday || 0;
    StorageManager.save(AppState);
    renderFocusGrowthHeatmap();
  }
});

/* =============================================
   GUIDED BREAKS ? CONTROLLER
   ============================================= */

function showGBSelector() {
  document.getElementById('gb-selector').style.display = '';
  ['eye','hydration','breathing','stretch'].forEach(t => {
    const v = document.getElementById('gb-view-' + t);
    if (v) v.style.display = 'none';
  });
}

function showGBView(type) {
  document.getElementById('gb-selector').style.display = 'none';
  const view = document.getElementById('gb-view-' + type);
  if (view) view.style.display = '';
  if (type === 'hydration') _gbHydrationRefresh();
  if (type === 'stretch')   _gbStretchInit();
}

// Wire selector cards
document.querySelectorAll('.gb-card').forEach(card => {
  card.addEventListener('click', () => showGBView(card.dataset.break));
});

// Back buttons
['eye','hydration','breathing','stretch'].forEach(t => {
  const btn = document.getElementById('btn-' + t + '-back');
  if (btn) btn.addEventListener('click', () => {
    _gbStopAll();
    showGBSelector();
  });
});

function _gbStopAll() {
  _gbEyeStop();
  _gbBreathStop();
  _gbStretchStop();
}

/* ---- EYE CARE ---- */
let _gbEyeInterval = null;
let _gbEyeSeconds = 20;

function _gbEyeStop() {
  clearInterval(_gbEyeInterval);
  _gbEyeInterval = null;
  const dot = document.getElementById('gb-eye-dot');
  if (dot) dot.classList.remove('gb-eye-dot--animating');
}

function _gbEyeReset() {
  _gbEyeStop();
  _gbEyeSeconds = 20;
  const countEl = document.getElementById('gb-eye-count');
  const ring = document.getElementById('gb-eye-ring');
  if (countEl) countEl.textContent = '20';
  if (ring) ring.style.strokeDashoffset = '314.16';
  const btn = document.getElementById('btn-eye-start');
  if (btn) btn.textContent = '? Begin Eye Break';
}

document.getElementById('btn-eye-start')?.addEventListener('click', () => {
  if (_gbEyeInterval) { _gbEyeStop(); document.getElementById('btn-eye-start').textContent = '? Begin Eye Break'; return; }
  const dot = document.getElementById('gb-eye-dot');
  if (dot) dot.classList.add('gb-eye-dot--animating');
  document.getElementById('btn-eye-start').textContent = '? Pause';
  _gbEyeInterval = setInterval(() => {
    _gbEyeSeconds--;
    const countEl = document.getElementById('gb-eye-count');
    const ring = document.getElementById('gb-eye-ring');
    if (countEl) countEl.textContent = _gbEyeSeconds;
    if (ring) ring.style.strokeDashoffset = 314.16 * (1 - (20 - _gbEyeSeconds) / 20);
    if (_gbEyeSeconds <= 0) {
      _gbEyeReset();
      showToast('Eye break complete! ');
      AppState.achievements.eyeProtector = (AppState.achievements.eyeProtector || 0) + 1;
      BurnoutEngine.completeBreak();
      MiloController.celebrate();
      AchievementEngine.checkAll();
    }
  }, 1000);
});

document.getElementById('btn-eye-reset')?.addEventListener('click', _gbEyeReset);

/* ---- HYDRATION ---- */
function _gbHydrationRefresh() {
  const current = AppState.waterIntakeToday;
  const goal = AppState.settings.dailyWaterGoal;
  const pct = Math.min(Math.round((current / goal) * 100), 100);

  const el = id => document.getElementById(id);
  if (el('gb-water-current')) el('gb-water-current').textContent = current;
  if (el('gb-water-goal'))    el('gb-water-goal').textContent = goal;
  if (el('gb-water-goal-display')) el('gb-water-goal-display').textContent = goal;
  if (el('gb-water-progress')) el('gb-water-progress').style.width = pct + '%';
  if (el('gb-glass-fill'))    el('gb-glass-fill').style.height = pct + '%';
  if (el('gb-glass-pct'))     el('gb-glass-pct').textContent = pct + '%';

  const iconsEl = el('gb-water-icons');
  if (iconsEl) {
    iconsEl.innerHTML = '';
    for (let i = 0; i < goal; i++) {
      const span = document.createElement('span');
      span.className = 'gb-water-icon' + (i < current ? ' gb-water-icon--filled' : '');
      span.textContent = '';
      iconsEl.appendChild(span);
    }
  }
}

document.getElementById('btn-log-glass')?.addEventListener('click', () => {
  incrementWaterIntake();
  _gbHydrationRefresh();
  showToast('Glass logged! ');
  if (AppState.waterIntakeToday >= AppState.settings.dailyWaterGoal) {
    showToast('Daily water goal reached! ');
    MiloController.celebrate();
  }
});

/* ---- BREATHING ---- */
let _gbBreathTimer = null;
let _gbBreathCycles = 0;
const GB_BREATH_MAX_CYCLES = 4;

function _gbBreathStop() {
  clearTimeout(_gbBreathTimer);
  _gbBreathTimer = null;
  const circle = document.getElementById('gb-breath-circle');
  if (circle) { circle.className = 'gb-breath-circle'; }
  const label = document.getElementById('gb-breath-label');
  if (label) label.textContent = 'Press Start';
}

function _gbBreathCycle() {
  if (_gbBreathCycles >= GB_BREATH_MAX_CYCLES) {
    _gbBreathStop();
    showToast('Breathing session complete! ');
    BurnoutEngine.completeBreak();
    MiloController.celebrate();
    return;
  }
  const circle = document.getElementById('gb-breath-circle');
  const label  = document.getElementById('gb-breath-label');
  const cyclesEl = document.getElementById('gb-breath-cycles');

  // Inhale 4s
  if (circle) { circle.className = 'gb-breath-circle gb-breath-circle--inhale'; }
  if (label)  label.textContent = 'Breathe In...';
  _gbBreathTimer = setTimeout(() => {
    // Hold 7s
    if (circle) { circle.className = 'gb-breath-circle gb-breath-circle--hold'; }
    if (label)  label.textContent = 'Hold...';
    _gbBreathTimer = setTimeout(() => {
      // Exhale 8s
      if (circle) { circle.className = 'gb-breath-circle gb-breath-circle--exhale'; }
      if (label)  label.textContent = 'Breathe Out...';
      _gbBreathTimer = setTimeout(() => {
        _gbBreathCycles++;
        if (cyclesEl) cyclesEl.textContent = _gbBreathCycles + ' / ' + GB_BREATH_MAX_CYCLES;
        _gbBreathCycle();
      }, 8000);
    }, 7000);
  }, 4000);
}

document.getElementById('btn-breath-start')?.addEventListener('click', () => {
  if (_gbBreathTimer) return;
  _gbBreathCycles = 0;
  const cyclesEl = document.getElementById('gb-breath-cycles');
  if (cyclesEl) cyclesEl.textContent = '0 / ' + GB_BREATH_MAX_CYCLES;
  _gbBreathCycle();
});

document.getElementById('btn-breath-stop')?.addEventListener('click', () => {
  _gbBreathStop();
});

/* ---- STRETCH ---- */
const GB_STRETCHES = [
  { id: 'neck',     name: 'Neck Rolls',       desc: 'Gently roll your neck in a circular motion. Release the tension stored from the day\'s posture.', duration: 30, figureClass: 'gb-stretch-figure--neck' },
  { id: 'shoulder', name: 'Shoulder Shrugs',  desc: 'Lift your shoulders up toward your ears, hold for 2 seconds, then release. Repeat slowly.', duration: 30, figureClass: 'gb-stretch-figure--shoulder' },
  { id: 'wrist',    name: 'Wrist Circles',    desc: 'Extend your arms and rotate your wrists in full circles. Switch direction halfway through.', duration: 30, figureClass: 'gb-stretch-figure--wrist' },
  { id: 'catcow',   name: 'Seated Cat-Cow',   desc: 'Arch your back gently (cow), then round it (cat). Breathe deeply with each movement.', duration: 45, figureClass: 'gb-stretch-figure--catcow' }
];

let _gbStretchIndex = 0;
let _gbStretchSeconds = 0;
let _gbStretchInterval = null;
let _gbStretchPaused = false;

function _gbStretchStop() {
  clearInterval(_gbStretchInterval);
  _gbStretchInterval = null;
}

function _gbStretchInit() {
  _gbStretchStop();
  _gbStretchIndex = 0;
  _gbStretchPaused = false;
  _gbStretchRender();
  document.getElementById('btn-stretch-pause').textContent = '? Pause Break';
}

function _gbStretchRender() {
  const s = GB_STRETCHES[_gbStretchIndex];
  _gbStretchSeconds = s.duration;
  const el = id => document.getElementById(id);
  if (el('gb-stretch-crumb'))          el('gb-stretch-crumb').textContent = s.name.toUpperCase();
  if (el('gb-stretch-title'))          el('gb-stretch-title').innerHTML = s.name.replace(' ', '<br><em>') + '</em>';
  if (el('gb-stretch-desc'))           el('gb-stretch-desc').textContent = s.desc;
  if (el('gb-stretch-count'))          el('gb-stretch-count').textContent = s.duration;
  if (el('gb-stretch-progress-label')) el('gb-stretch-progress-label').textContent = (_gbStretchIndex + 1) + ' of ' + GB_STRETCHES.length;
  if (el('gb-stretch-progress-fill'))  el('gb-stretch-progress-fill').style.width = ((_gbStretchIndex + 1) / GB_STRETCHES.length * 100) + '%';
  const fig = document.getElementById('gb-stretch-figure');
  if (fig) fig.className = 'gb-stretch-figure ' + s.figureClass;
  _gbStretchStart();
}

function _gbStretchStart() {
  _gbStretchStop();
  _gbStretchInterval = setInterval(() => {
    if (_gbStretchPaused) return;
    _gbStretchSeconds--;
    const countEl = document.getElementById('gb-stretch-count');
    if (countEl) countEl.textContent = _gbStretchSeconds;
    if (_gbStretchSeconds <= 0) {
      _gbStretchStop();
      _gbStretchIndex++;
      if (_gbStretchIndex >= GB_STRETCHES.length) {
        showToast('Stretch session complete! ');
        AppState.achievements.stretchMaster = (AppState.achievements.stretchMaster || 0) + 1;
        BurnoutEngine.completeBreak();
        MiloController.celebrate();
        AchievementEngine.checkAll();
        showGBSelector();
      } else {
        _gbStretchRender();
      }
    }
  }, 1000);
}

document.getElementById('btn-stretch-pause')?.addEventListener('click', () => {
  _gbStretchPaused = !_gbStretchPaused;
  const btn = document.getElementById('btn-stretch-pause');
  if (btn) btn.textContent = _gbStretchPaused ? '? Resume Break' : '? Pause Break';
});

document.getElementById('btn-stretch-skip')?.addEventListener('click', () => {
  _gbStretchStop();
  _gbStretchIndex++;
  if (_gbStretchIndex >= GB_STRETCHES.length) {
    showToast('Stretch session complete! ');
    showGBSelector();
  } else {
    _gbStretchRender();
  }
});

/* =============================================
   SESSION PLAN ? SETTINGS
   ============================================= */
let _pendingSessionCount = 4;

function _renderSessionPlan() {
  const preview = document.getElementById('session-plan-preview');
  const summary = document.getElementById('session-plan-summary');
  const workMin = AppState.settings.workDuration || 25;
  const totalMin = _pendingSessionCount * workMin;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  const totalStr = hrs > 0 ? hrs + 'h ' + (mins > 0 ? mins + 'min' : '') : mins + 'min';

  if (preview) {
    preview.innerHTML = '';
    for (let i = 0; i < _pendingSessionCount; i++) {
      const dot = document.createElement('div');
      dot.className = 'session-dot';
      dot.textContent = i + 1;
      if (i < AppState.sessionsCompleted) dot.classList.add('session-dot--completed');
      else if (i === AppState.sessionsCompleted) dot.classList.add('session-dot--current');
      preview.appendChild(dot);
    }
  }
  if (summary) {
    summary.innerHTML = _pendingSessionCount + ' sessions &times; ' + workMin + ' min = <strong>' + totalStr + '</strong> total focus time';
  }
  const valEl = document.getElementById('val-session-count');
  if (valEl) valEl.textContent = _pendingSessionCount;
}

document.getElementById('btn-sessions-minus')?.addEventListener('click', () => {
  if (_pendingSessionCount > 1) { _pendingSessionCount--; _renderSessionPlan(); }
});

document.getElementById('btn-sessions-plus')?.addEventListener('click', () => {
  if (_pendingSessionCount < 30) { _pendingSessionCount++; _renderSessionPlan(); }
});

// Patch initSettingsPage to also load session count and render plan
const _origInitSettings = initSettingsPage;
initSettingsPage = function() {
  _origInitSettings();
  _pendingSessionCount = AppState.settings.sessionCount || 4;
  _renderSessionPlan();
};

// Patch save button to also save sessionCount
const _origSaveBtn = document.getElementById('btn-save-settings');
if (_origSaveBtn) {
  _origSaveBtn.addEventListener('click', () => {
    AppState.settings.sessionCount = _pendingSessionCount;
  }, true); // capture phase so it runs before the cloned listener
}

// Also update session plan dots when sessions complete
TimerEngine.onSessionComplete((mode) => {
  if (mode === 'work') _renderSessionPlan();
});

// Initialize on page show
const _origShowPage = showPage;
showPage = function(name) {
  _origShowPage(name);
  if (name === 'guided-breaks') showGBSelector();
  if (name === 'settings') { _pendingSessionCount = AppState.settings.sessionCount || 4; _renderSessionPlan(); }
  if (name === 'dashboard') renderFocusInsights();
};

/* =============================================
   FOCUS INSIGHTS RENDERER
   ============================================= */
function renderFocusInsights() {
  const el = id => document.getElementById(id);

  // Average duration
  const sessions = AppState.sessionHistory || [];
  if (sessions.length > 0) {
    const totalDur = sessions.reduce((sum, s) => sum + (s.duration || AppState.settings.workDuration), 0);
    const avg = Math.round(totalDur / sessions.length);
    if (el('insight-avg-duration')) el('insight-avg-duration').textContent = avg + 'm';
  } else {
    if (el('insight-avg-duration')) el('insight-avg-duration').textContent = AppState.settings.workDuration + 'm';
  }

  // Streak
  if (el('insight-streak')) {
    const days = AppState.streakDays || 0;
    el('insight-streak').textContent = days + (days === 1 ? ' day' : ' days');
  }

  // Sessions today
  if (el('insight-sessions-today')) {
    el('insight-sessions-today').textContent = AppState.totalSessionsToday || 0;
  }

  // Mood (last feeling check-in)
  if (el('insight-mood')) {
    const mood = AppState.lastMood || null;
    const moodEmojis = {
      great: '😊',
      tired: '😴',
      stressed: '😰',
      focused: '🎯'
    };
    el('insight-mood').textContent = mood ? moodEmojis[mood] || '—' : '—';
  }
}

// Update Focus Insights when sessions complete
TimerEngine.onSessionComplete((mode) => {
  if (mode === 'work') renderFocusInsights();
});

/* =============================================
   FEELING CHECK-IN -> TRACK LAST MOOD
   ============================================= */
// Patch feeling buttons to save last mood to AppState
document.querySelectorAll('.feeling-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    AppState.lastMood = btn.dataset.feeling;
    StorageManager.save(AppState);
    renderFocusInsights();
  });
});

/* =============================================
   DARK MODE TOGGLE
   ============================================= */
const DarkModeController = (() => {
  const STORAGE_KEY = 'mindfulbreak_darkmode';

  function _isEnabled() {
    try {
      return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch (e) {
      return false;
    }
  }

  function _save(val) {
    try {
      localStorage.setItem(STORAGE_KEY, val ? 'true' : 'false');
    } catch (e) { /* ignore */ }
  }

  function apply(dark) {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    _save(dark);
  }

  function toggle() {
    const current = document.documentElement.getAttribute('data-theme') === 'dark';
    apply(!current);
  }

  function init() {
    const dark = _isEnabled();
    apply(dark);
    const btn = document.getElementById('dark-mode-toggle');
    if (btn) btn.addEventListener('click', toggle);
  }

  return { init, toggle, apply };
})();

DarkModeController.init();

/* =============================================
   TIMER MODE COLOR DISTINCTION
   ============================================= */
function updateTimerModeAttribute() {
  document.documentElement.setAttribute('data-timer-mode', AppState.timerMode);
}

// Update on every tick and session complete
TimerEngine.onTick(() => updateTimerModeAttribute());
TimerEngine.onSessionComplete(() => updateTimerModeAttribute());
// Initial set
updateTimerModeAttribute();

/* =============================================
   ALL-SESSIONS-COMPLETED CELEBRATION
   ============================================= */
TimerEngine.onSessionComplete((mode) => {
  if (mode === 'work') {
    const target = AppState.settings.sessionCount || 4;
    if (AppState.sessionsCompleted >= target) {
      // All sessions done! Big celebration
      setTimeout(() => {
        triggerConfetti();
        triggerConfetti(); // Extra confetti
        MiloController.celebrate();
        showToast('🎉 All sessions completed! Amazing work today!');

        // Update speech bubble
        const bubble = document.getElementById('milo-speech-bubble');
        const quoteEl = bubble ? bubble.querySelector('.milo-quote') : null;
        if (quoteEl) {
          bubble.style.opacity = '0';
          setTimeout(() => {
            quoteEl.innerHTML = '<em>"AMAZING!! Kamu berhasil selesaikan semua sesi! Milo bangga banget! 🌟"</em>';
            bubble.style.opacity = '1';
          }, 200);
        }
      }, 500);
    }
  }
});

/* =============================================
   MINDFULNESS QUOTE ROTATION
   ============================================= */
const MINDFULNESS_QUOTES = [
  "The rhythm of your focus is the heartbeat of your creativity. Listen to it with stillness.",
  "Rest is not idleness. It is the soil in which the seeds of your next idea grow.",
  "A calm mind is not the absence of storms, but the ability to find peace amidst them.",
  "Your attention is a garden. What you water, grows. What you ignore, fades.",
  "Progress is not measured in hours worked, but in moments of clarity found.",
  "The space between breaths is where productivity meets peace.",
  "Take breaks not because you're tired, but because you deserve to thrive.",
  "The best ideas come when the mind is free to wander. Give yourself permission.",
  "Your body is the vessel of your ambition. Care for it like the treasure it is.",
  "In the pause between tasks, you'll find the perspective that transforms everything.",
  "Every deep breath is a reset button. Press it often.",
  "Focus flows best when it's balanced with rest. Honor both equally.",
  "The most productive thing you can do right now might be to stop and breathe.",
  "Small breaks create big breakthroughs. Trust the process.",
  "Your wellbeing is not a luxury. It is the foundation of everything you build."
];

function rotateMinfulnessQuote() {
  const quoteEl = document.getElementById('mindfulness-quote-text');
  if (!quoteEl) return;
  const randomIdx = Math.floor(Math.random() * MINDFULNESS_QUOTES.length);
  quoteEl.textContent = '"' + MINDFULNESS_QUOTES[randomIdx] + '"';
}

// Rotate quote every time History page is opened (already handled via showPage -> renderHistoryPage)
// Patch renderHistoryPage to also rotate quote
const _origRenderHistory = renderHistoryPage;
renderHistoryPage = function() {
  _origRenderHistory();
  rotateMinfulnessQuote();
};

/* =============================================
   FLOATING TOOLBAR & PANEL CONTROLLER
   ============================================= */
const FloatingToolbar = (() => {
  let _activePanel = null;

  function _openPanel(panelId) {
    const overlay = document.getElementById(panelId);
    if (!overlay) return;
    overlay.classList.add('open');
    const panel = overlay.querySelector('.fp-panel');
    // Use requestAnimationFrame to ensure display:flex is applied before transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        panel.classList.add('visible');
      });
    });
  }

  function _closePanel(panelId, cb) {
    const overlay = document.getElementById(panelId);
    if (!overlay) return;
    const panel = overlay.querySelector('.fp-panel');
    panel.classList.remove('visible');
    // Wait for CSS transition to finish before hiding overlay
    setTimeout(() => {
      overlay.classList.remove('open');
      if (cb) cb();
    }, 350);
  }

  function toggle(panelId) {
    if (_activePanel === panelId) {
      _closePanel(panelId);
      _activePanel = null;
      _updateButtons();
      return;
    }
    if (_activePanel) {
      _closePanel(_activePanel, () => {
        _activePanel = panelId;
        _openPanel(panelId);
        _updateButtons();
      });
    } else {
      _activePanel = panelId;
      _openPanel(panelId);
      _updateButtons();
    }
  }

  function closeAll() {
    if (_activePanel) {
      _closePanel(_activePanel);
      _activePanel = null;
      _updateButtons();
    }
  }

  function _updateButtons() {
    document.querySelectorAll('.ft-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.panel === _activePanel);
    });
  }

  function init() {
    document.querySelectorAll('.ft-btn').forEach(btn => {
      btn.addEventListener('click', () => toggle(btn.dataset.panel));
    });

    document.querySelectorAll('[data-close-panel]').forEach(btn => {
      btn.addEventListener('click', () => {
        const panelId = btn.dataset.closePanel;
        _closePanel(panelId);
        if (_activePanel === panelId) _activePanel = null;
        _updateButtons();
      });
    });

    document.querySelectorAll('.fp-overlay').forEach(overlay => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAll();
      });
    });
  }

  return { init, toggle, closeAll };
})();

FloatingToolbar.init();


/* =============================================
   AMBIENCE MIXER — Web Audio API
   ============================================= */
const AmbienceMixer = (() => {
  let _ctx = null;
  const _nodes = {};
  const STORAGE_KEY = 'mindfulbreak_ambience';

  function _getCtx() {
    if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  // Noise generator
  function _createNoise(type) {
    const ctx = _getCtx();
    const bufferSize = 2 * ctx.sampleRate;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    switch (type) {
      case 'rain':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * 0.3;
          // Add occasional louder drops
          if (Math.random() < 0.001) data[i] *= 4;
        }
        break;
      case 'ocean':
        for (let i = 0; i < bufferSize; i++) {
          const wave = Math.sin(i / (ctx.sampleRate * 4)) * 0.5;
          data[i] = (Math.random() * 2 - 1) * 0.15 * (0.5 + wave * 0.5);
        }
        break;
      case 'wind':
        for (let i = 0; i < bufferSize; i++) {
          const mod = Math.sin(i / (ctx.sampleRate * 6)) * 0.5 + 0.5;
          data[i] = (Math.random() * 2 - 1) * 0.2 * mod;
        }
        break;
      case 'campfire':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * 0.15;
          if (Math.random() < 0.005) data[i] *= 3;
        }
        break;
      case 'birds':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = 0;
          if (Math.random() < 0.0008) {
            const chirpLen = Math.floor(Math.random() * 800) + 200;
            for (let j = 0; j < chirpLen && i + j < bufferSize; j++) {
              data[i + j] = Math.sin(j * (0.1 + Math.random() * 0.15)) * 0.3 * (1 - j / chirpLen);
            }
            i += 800;
          }
        }
        break;
      case 'cafe':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * 0.08;
          if (Math.random() < 0.0005) data[i] += (Math.random() - 0.5) * 0.4;
        }
        break;
      case 'keyboard':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = 0;
          if (Math.random() < 0.0012) {
            const clickLen = Math.floor(Math.random() * 120) + 40;
            for (let j = 0; j < clickLen && i + j < bufferSize; j++) {
              data[i + j] = (Math.random() * 2 - 1) * 0.4 * (1 - j / clickLen);
            }
            i += 160;
          }
        }
        break;
      case 'night':
        for (let i = 0; i < bufferSize; i++) {
          data[i] = (Math.random() * 2 - 1) * 0.02;
          if (Math.random() < 0.0006) {
            const chirpLen = Math.floor(Math.random() * 600) + 300;
            for (let j = 0; j < chirpLen && i + j < bufferSize; j++) {
              data[i + j] += Math.sin(j * 0.08) * 0.2 * (1 - j / chirpLen);
            }
            i += 500;
          }
        }
        break;
      default:
        for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.1;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    // Add filter for smoother sound
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = type === 'rain' ? 3000 : type === 'ocean' ? 800 : type === 'wind' ? 600 : 4000;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start();

    return { source, gain, filter };
  }

  function _toggleSound(type) {
    if (_nodes[type]) {
      // Stop
      _nodes[type].gain.gain.linearRampToValueAtTime(0, _getCtx().currentTime + 0.3);
      setTimeout(() => {
        try { _nodes[type].source.stop(); } catch (e) {}
        delete _nodes[type];
      }, 350);
      return false;
    } else {
      // Start
      const node = _createNoise(type);
      _nodes[type] = node;
      const vol = _getSliderValue(type);
      node.gain.gain.linearRampToValueAtTime(vol, _getCtx().currentTime + 0.3);
      return true;
    }
  }

  function _setVolume(type, vol) {
    if (_nodes[type]) {
      _nodes[type].gain.gain.linearRampToValueAtTime(vol, _getCtx().currentTime + 0.1);
    }
  }

  function _getSliderValue(type) {
    const slider = document.querySelector(`.ambience-slider[data-sound="${type}"]`);
    return slider ? slider.value / 100 * 0.6 : 0.3;
  }

  function _saveState() {
    const state = {};
    document.querySelectorAll('.ambience-card').forEach(card => {
      const type = card.dataset.sound;
      state[type] = {
        active: card.classList.contains('active'),
        volume: card.querySelector('.ambience-slider').value
      };
    });
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function _loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw);
      Object.entries(state).forEach(([type, s]) => {
        const card = document.querySelector(`.ambience-card[data-sound="${type}"]`);
        if (!card) return;
        const slider = card.querySelector('.ambience-slider');
        if (slider) slider.value = s.volume;
        // Don't auto-play on load — user must click to resume (browser autoplay policy)
      });
    } catch (e) {}
  }

  function init() {
    _loadState();

    document.querySelectorAll('.ambience-card').forEach(card => {
      const type = card.dataset.sound;
      const slider = card.querySelector('.ambience-slider');

      // Click card to toggle sound
      card.addEventListener('click', (e) => {
        if (e.target.classList.contains('ambience-slider')) return; // Don't toggle on slider drag
        const active = _toggleSound(type);
        card.classList.toggle('active', active);

        // Anime.js pulse animation
        if (active && typeof anime !== 'undefined') {
          anime({
            targets: card,
            scale: [1, 1.06, 1],
            duration: 400,
            easing: 'easeOutElastic(1, .5)'
          });
        }
        _saveState();
      });

      // Volume slider
      slider.addEventListener('input', () => {
        const vol = slider.value / 100 * 0.6;
        _setVolume(type, vol);
        _saveState();
      });

      // Prevent slider click from bubbling to card toggle
      slider.addEventListener('click', (e) => e.stopPropagation());
    });
  }

  return { init };
})();

AmbienceMixer.init();


/* =============================================
   MUSIC PLAYER — YouTube / Spotify Embed
   ============================================= */
const MusicPlayer = (() => {
  const STORAGE_KEY = 'mindfulbreak_music_url';

  function _parseYouTube(url) {
    // youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID, youtube.com/live/ID
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
      /youtube\.com\/.*[?&]v=([a-zA-Z0-9_-]{11})/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  function _parseSpotify(url) {
    // open.spotify.com/track/ID, open.spotify.com/playlist/ID, open.spotify.com/album/ID
    const m = url.match(/open\.spotify\.com\/(track|playlist|album)\/([a-zA-Z0-9]+)/);
    if (m) return { type: m[1], id: m[2] };
    return null;
  }

  function _loadUrl(url) {
    const container = document.getElementById('music-embed-container');
    if (!container) return;

    // Try YouTube
    const ytId = _parseYouTube(url);
    if (ytId) {
      container.innerHTML = `<iframe src="https://www.youtube.com/embed/${ytId}?autoplay=1" width="100%" height="200" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
      _save(url);
      return;
    }

    // Try Spotify
    const sp = _parseSpotify(url);
    if (sp) {
      const height = sp.type === 'track' ? 152 : 352;
      container.innerHTML = `<iframe src="https://open.spotify.com/embed/${sp.type}/${sp.id}?utm_source=generator&theme=0" width="100%" height="${height}" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
      _save(url);
      return;
    }

    // Unknown URL
    showToast('⚠️ Unrecognized URL. Please paste a YouTube or Spotify link.');
  }

  function _save(url) {
    try { localStorage.setItem(STORAGE_KEY, url); } catch (e) {}
  }

  function _load() {
    try { return localStorage.getItem(STORAGE_KEY) || ''; } catch (e) { return ''; }
  }

  function init() {
    const input = document.getElementById('music-url-input');
    const btn = document.getElementById('music-load-btn');
    if (!btn || !input) return;

    // Restore saved URL
    const savedUrl = _load();
    if (savedUrl) {
      input.value = savedUrl;
    }

    btn.addEventListener('click', () => {
      const url = input.value.trim();
      if (!url) return;
      _loadUrl(url);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = input.value.trim();
        if (url) _loadUrl(url);
      }
    });
  }

  return { init };
})();

MusicPlayer.init();


/* =============================================
   TO-DO PAGE — Mindful Intentions Controller
   ============================================= */
const TodoPage = (() => {
  const STORAGE_KEY = 'mindfulbreak_intentions';
  const CAT_LABELS = {
    'deep-work': 'Deep Work',
    'creative-flow': 'Creative Flow',
    'light-focus': 'Light Focus'
  };

  const REFLECTIONS = [
    '"The forest does not hurry, yet everything is accomplished."',
    '"Be like water — sometimes still, sometimes in motion, always purposeful."',
    '"A single seed of intention can grow into a forest of achievement."',
    '"Patience is not passive; it is concentrated strength."',
    '"Do not rush the seasons of your growth."',
    '"What you nurture with attention will flourish in time."',
    '"Small consistent steps create lasting transformation."',
    '"Let your work be rooted in calm, not urgency."'
  ];

  function _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function _save(tasks) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch (e) {}
  }

  function _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function _renderItem(task, idx) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (task.done ? ' done' : '');
    li.innerHTML = `
      <button class="todo-item__checkbox ${task.done ? 'checked' : ''}" data-idx="${idx}"></button>
      <div class="todo-item__content">
        <div class="todo-item__title">${_escapeHtml(task.text)}</div>
        <div class="todo-item__meta">
          <span class="todo-item__tag todo-item__tag--${task.category || 'light-focus'}">${CAT_LABELS[task.category] || 'Light Focus'}</span>
          ${task.linkedSession ? '<span class="todo-item__session-link">● LINK FOCUS SESSION</span>' : ''}
        </div>
      </div>
      <button class="todo-item__delete" data-idx="${idx}" title="Delete">&times;</button>
    `;
    return li;
  }

  function render() {
    const dailyList = document.getElementById('todo-daily-list');
    const futureList = document.getElementById('todo-future-list');
    const pendingCount = document.getElementById('todo-pending-count');
    const statMinutes = document.getElementById('todo-stat-minutes');
    const statIntentions = document.getElementById('todo-stat-intentions');

    if (!dailyList) return;

    const tasks = _load();
    const activeTasks = tasks.filter(t => !t.done);
    const doneTasks = tasks.filter(t => t.done);

    // Update counter
    if (pendingCount) {
      pendingCount.textContent = `${String(activeTasks.length).padStart(2, '0')} TASKS REMAINING`;
    }

    // Update stats
    if (statIntentions) statIntentions.textContent = String(tasks.length).padStart(2, '0');
    if (statMinutes) {
      const mins = (AppState.sessionHistory || []).reduce((sum, s) => sum + (s.duration || 0), 0);
      statMinutes.textContent = String(Math.round(mins / 60)).padStart(2, '0');
    }

    // Daily Focus list (active tasks)
    dailyList.innerHTML = '';
    if (activeTasks.length === 0) {
      dailyList.innerHTML = '<li class="todo-empty">No active intentions. Plant a new seed to begin.</li>';
    } else {
      activeTasks.forEach((task, i) => {
        const realIdx = tasks.indexOf(task);
        dailyList.appendChild(_renderItem(task, realIdx));
      });
    }

    // Future Growth list (completed tasks)
    if (futureList) {
      futureList.innerHTML = '';
      if (doneTasks.length === 0) {
        futureList.innerHTML = '<li class="todo-empty">Completed intentions will appear here.</li>';
      } else {
        doneTasks.forEach(task => {
          const realIdx = tasks.indexOf(task);
          futureList.appendChild(_renderItem(task, realIdx));
        });
      }
    }

    // Rotate reflection quote
    const quoteEl = document.getElementById('todo-reflection-quote');
    if (quoteEl) {
      quoteEl.textContent = REFLECTIONS[Math.floor(Math.random() * REFLECTIONS.length)];
    }
  }

  function _toggleTask(idx) {
    const tasks = _load();
    if (tasks[idx]) {
      tasks[idx].done = !tasks[idx].done;
      _save(tasks);
      render();
    }
  }

  function _deleteTask(idx) {
    const tasks = _load();
    tasks.splice(idx, 1);
    _save(tasks);
    render();
  }

  function _addTask(text, category, linkedSession) {
    const tasks = _load();
    tasks.push({
      text,
      category: category || 'light-focus',
      linkedSession: !!linkedSession,
      done: false,
      id: Date.now(),
      createdAt: new Date().toISOString()
    });
    _save(tasks);
    render();
  }

  function _openModal() {
    const overlay = document.getElementById('intention-modal-overlay');
    if (overlay) overlay.classList.add('open');
    const input = document.getElementById('intention-input');
    if (input) { input.value = ''; input.focus(); }
    // Reset category selection
    document.querySelectorAll('.intention-cat').forEach(c => c.classList.remove('active'));
    const defaultCat = document.querySelector('.intention-cat[data-cat="creative-flow"]');
    if (defaultCat) defaultCat.classList.add('active');
    // Reset toggle
    const toggle = document.getElementById('intention-link-session');
    if (toggle) toggle.checked = false;
  }

  function _closeModal() {
    const overlay = document.getElementById('intention-modal-overlay');
    if (overlay) overlay.classList.remove('open');
  }

  function init() {
    // Plant New Intention button -> opens modal
    const plantBtn = document.getElementById('todo-plant-btn');
    if (plantBtn) plantBtn.addEventListener('click', _openModal);

    // Modal close
    const closeBtn = document.getElementById('intention-modal-close');
    if (closeBtn) closeBtn.addEventListener('click', _closeModal);

    const discardBtn = document.getElementById('intention-discard');
    if (discardBtn) discardBtn.addEventListener('click', _closeModal);

    // Click overlay to close
    const overlay = document.getElementById('intention-modal-overlay');
    if (overlay) overlay.addEventListener('click', (e) => {
      if (e.target === overlay) _closeModal();
    });

    // Category selection
    document.querySelectorAll('.intention-cat').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.intention-cat').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Submit intention
    const submitBtn = document.getElementById('intention-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        const input = document.getElementById('intention-input');
        const text = input ? input.value.trim() : '';
        if (!text) { if (input) input.focus(); return; }
        const activeCat = document.querySelector('.intention-cat.active');
        const category = activeCat ? activeCat.dataset.cat : 'light-focus';
        const linked = document.getElementById('intention-link-session');
        _addTask(text, category, linked ? linked.checked : false);
        _closeModal();
        showToast('🌱 Intention planted!');
      });
    }

    // Enter key in input submits
    const input = document.getElementById('intention-input');
    if (input) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (submitBtn) submitBtn.click();
      }
    });

    // Task list click delegation
    const dailyList = document.getElementById('todo-daily-list');
    const futureList = document.getElementById('todo-future-list');

    [dailyList, futureList].forEach(list => {
      if (!list) return;
      list.addEventListener('click', (e) => {
        const checkbox = e.target.closest('.todo-item__checkbox');
        const deleteBtn = e.target.closest('.todo-item__delete');
        if (checkbox) _toggleTask(parseInt(checkbox.dataset.idx));
        if (deleteBtn) _deleteTask(parseInt(deleteBtn.dataset.idx));
      });
    });

    render();
  }

  return { init, render };
})();

TodoPage.init();
