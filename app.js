/**
 * ============================================================================
 * CleanDose PLC - Motor de Simulación Industrial & Lógica de Control en Vivo
 * Arquitectura: Ciclo Scan Determinístico (50ms) según IEC 61131-3 & ISA-101
 * ============================================================================
 */

(function () {
  'use strict';

  // ==========================================================================
  // 1. ESTADO GLOBAL DEL SISTEMA PLC (MEMORIA INTERNA Y E/S)
  // ==========================================================================
  const PLC = {
    // Modo de ejecución
    runMode: 'RUN', // 'RUN' | 'STOP' | 'ALARM'
    scanIntervalMs: 50,
    timeScale: 1.0, // 1.0x o 2.0x
    lastScanTimestamp: performance.now(),
    watchdogOk: true,

    // Entradas Digitales (%I0.0 a %I0.7)
    inputs: {
      I00_Start: false,     // Pulsador START (NA)
      I01_Stop: true,       // Pulsador STOP (NC: true en reposo)
      I02_CarboyPresent: false, // Sensor óptico de bidón (I0.2)
      I03_LevelT1Ok: true,  // Nivel Tanque 1 > 15% (I0.3)
      I04_LevelT2Ok: true,  // Nivel Tanque 2 > 15% (I0.4)
      I05_Recipe: 0,        // 0 = Hogar, 1 = Industrial (I0.5)
      I06_EStopOk: true,    // Paro Emergencia (NC: true = seguro, false = oprimido)
      I07_Reset: false      // Pulsador Reset Alarmas / Contador (I0.7)
    },

    // Salidas Digitales (%Q0.0 a %Q0.4)
    outputs: {
      Q00_ValveBase: false,     // EV1 Válvula Base Agua
      Q01_ValveConc: false,     // EV2 Válvula Concentrado
      Q02_MotorMixer: false,    // MTR1 Agitador Homogeneizador
      Q03_LightReady: false,    // Piloto Verde Fin de Ciclo
      Q04_BeaconAlarm: false    // Baliza Roja Alarma / Paro Emergencia
    },

    // Marcas de Memoria Auxiliares (%M)
    memory: {
      M00_SystemRun: false,     // Enclavamiento de marcha del ciclo
      M04_PokaYokeLock: false,  // Bit de bloqueo anti-doble llenado
      M01_PrevCarboy: false,    // Detección de flanco del sensor de bidón
      M02_CycleCompleted: false
    },

    // Temporizadores de Retardo a la Conexión (TON)
    timers: {
      T1: { IN: false, PT: 4.0, ET: 0.0, Q: false, startTime: 0 }, // Base Agua (4s)
      T2: { IN: false, PT: 2.0, ET: 0.0, Q: false, startTime: 0 }, // Conc Hogar (2s)
      T3: { IN: false, PT: 5.0, ET: 0.0, Q: false, startTime: 0 }, // Conc Industrial (5s)
      T4: { IN: false, PT: 3.0, ET: 0.0, Q: false, startTime: 0 }  // Mezcla (3s / 4s)
    },

    // Contador Ascendente (CTU C1)
    counters: {
      C1: { CV: 0, PV: 9999, Q: false, prevCU: false }
    },

    // Físicos de Planta
    plant: {
      t1LevelPct: 85,    // Nivel Tanque 1 Base Agua (%)
      t2LevelPct: 80,    // Nivel Tanque 2 Concentrado (%)
      carboyLevelPct: 0, // Nivel líquido en el bidón actual (%)
      carboyVolumeMl: 0, // Volumen actual en ml
      totalLitersDispensed: 0.0,
      activePhase: 'IDLE', // 'IDLE', 'BASE', 'CONC', 'MIX', 'DONE', 'ALARM'
      phaseMessage: 'SISTEMA LISTO: COLOQUE UN BIDÓN VACÍO EN LA BASE RECEPTORA'
    },

    // Control de audio
    audioEnabled: true,

    // Modo de lógica (Sincronizado vs Manual)
    logicMode: 'SYNC'
  };

  // Historial de eventos para el certificado de lote
  const productionLog = [];

  // ==========================================================================
  // 2. SINTETIZADOR DE AUDIO INDUSTRIAL (WEB AUDIO API)
  // ==========================================================================
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  function playSound(type) {
    if (!PLC.audioEnabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'click') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(300, now + 0.04);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (type === 'valve_on') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
        osc.start(now);
        osc.stop(now + 0.09);
      } else if (type === 'mixer_hum') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(120, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.16);
      } else if (type === 'chime_done') {
        // Doble pitido melódico de éxito
        osc.type = 'sine';
        osc.frequency.setValueAtTime(587.33, now); // D5
        osc.frequency.setValueAtTime(880.00, now + 0.12); // A5
        gain.gain.setValueAtTime(0.18, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.35);
        osc.start(now);
        osc.stop(now + 0.36);
      } else if (type === 'alarm') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(880, now);
        osc.frequency.setValueAtTime(659.25, now + 0.1);
        gain.gain.setValueAtTime(0.22, now);
        gain.gain.linearRampToValueAtTime(0.01, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.24);
      }
    } catch (e) {
      console.warn("Audio synthesis error:", e);
    }
  }

  // ==========================================================================
  // 3. CICLO SCAN DEL PLC (IEC 61131-3)
  // ==========================================================================
  function plcScanCycle() {
    const now = performance.now();
    const dtSeconds = ((now - PLC.lastScanTimestamp) / 1000) * PLC.timeScale;
    PLC.lastScanTimestamp = now;

    // FASE 1: LECTURA DE IMAGEN DE ENTRADAS (PII)
    // Las entradas provienen de variables físicas y botones de usuario
    const I00 = PLC.inputs.I00_Start;
    const I01 = PLC.inputs.I01_Stop; // NC
    const I02 = PLC.inputs.I02_CarboyPresent;
    const I03 = PLC.inputs.I03_LevelT1Ok;
    const I04 = PLC.inputs.I04_LevelT2Ok;
    const I05 = PLC.inputs.I05_Recipe; // 0: Hogar, 1: Ind
    const I06 = PLC.inputs.I06_EStopOk; // NC
    const I07 = PLC.inputs.I07_Reset;

    // FASE 2: EVALUACIÓN DE CONDICIONES DE ALARMA Y PARO (NETWORK 6)
    const faultDetected = (!I06) || (!I03) || (!I04) || (!I01);
    if (faultDetected) {
      PLC.outputs.Q04_BeaconAlarm = true;
      PLC.runMode = 'ALARM';
      PLC.memory.M00_SystemRun = false; // Interrupción inmediata
    } else {
      PLC.outputs.Q04_BeaconAlarm = false;
      PLC.runMode = 'RUN';
    }

    // FASE 3: LÓGICA POKA-YOKE: DESENCLAVAMIENTO AL RETIRAR EL ENVASE (I0.2 = 0)
    if (!I02) {
      if (PLC.memory.M04_PokaYokeLock) {
        PLC.memory.M04_PokaYokeLock = false;
        logEvent('POKA-YOKE', 'Envase retirado de la estación. Memoria de bloqueo M0.4 liberada para nuevo ciclo.');
      }
      PLC.outputs.Q03_LightReady = false;
    }

    // FASE 4: RESET DE CONTADOR Y REARME (NETWORK 7)
    if (I07) {
      PLC.counters.C1.CV = 0;
      PLC.plant.totalLitersDispensed = 0.0;
      logEvent('RESET', 'Contador totalizador y registros rearmados manualmente por operario (I0.7).');
      PLC.inputs.I07_Reset = false; // Pulso momentáneo
    }

    // FASE 5: PERMISIVOS Y ENCLAVAMIENTO DE MARCHA (NETWORK 1)
    // M0.0 = (I0.0 + M0.0) · I0.1 · I0.2 · I0.3 · I0.4 · I0.6 · /M0.4
    const startPermissives = I01 && I02 && I03 && I04 && I06 && (!PLC.memory.M04_PokaYokeLock);

    if (I00 && !PLC.memory.M00_SystemRun) {
      if (startPermissives) {
        PLC.memory.M00_SystemRun = true;
        resetAllTimers();
        PLC.plant.carboyLevelPct = 0;
        PLC.plant.carboyVolumeMl = 0;
        playSound('valve_on');
        logEvent('START', `Inicio de ciclo. Receta: ${I05 === 0 ? 'Fórmula Hogar' : 'Fórmula Industrial'}`);
      } else {
        // Feedback de por qué no arranca
        if (PLC.memory.M04_PokaYokeLock) {
          PLC.plant.phaseMessage = "⚠️ BLOQUEO POKA-YOKE: RETIRE EL BIDÓN LLENO ANTES DE UN NUEVO CICLO";
          playSound('alarm');
        } else if (!I02) {
          PLC.plant.phaseMessage = "⚠️ FALTA ENVASE: COLOQUE UN BIDÓN VACÍO EN LA BASE (I0.2)";
          playSound('alarm');
        } else if (!I03 || !I04) {
          PLC.plant.phaseMessage = "🚨 ALARMA: NIVEL CRÍTICO EN TANQUES (<15%). RELLENE INSUMOS.";
          playSound('alarm');
        } else if (!I06) {
          PLC.plant.phaseMessage = "🚨 PARO DE EMERGENCIA OPRIMIDO (I0.6). DESTRABE EL HONGO.";
          playSound('alarm');
        }
      }
      PLC.inputs.I00_Start = false; // Reset de pulso de pulsador
    }

    // Si durante la marcha se pierden los permisivos, se cae M0.0
    if (PLC.memory.M00_SystemRun && !startPermissives) {
      PLC.memory.M00_SystemRun = false;
    }

    // FASE 6: SECUENCIA DE TIEMPOS (NETWORKS 2, 3, 4, 5)
    if (PLC.memory.M00_SystemRun) {
      // ETAPA 1: BASE AGUA (Q0.0) & TON T1 (4.0s)
      if (!PLC.timers.T1.Q) {
        PLC.plant.activePhase = 'BASE';
        PLC.plant.phaseMessage = 'DOSIFICANDO BASE AGUA PURIFICADA (EV1 Q0.0)...';
        PLC.outputs.Q00_ValveBase = true;
        PLC.outputs.Q01_ValveConc = false;
        PLC.outputs.Q02_MotorMixer = false;
        PLC.outputs.Q03_LightReady = false;

        PLC.timers.T1.IN = true;
        PLC.timers.T1.ET += dtSeconds;
        if (PLC.timers.T1.ET >= PLC.timers.T1.PT) {
          PLC.timers.T1.ET = PLC.timers.T1.PT;
          PLC.timers.T1.Q = true;
          PLC.outputs.Q00_ValveBase = false;
          playSound('valve_on');
        }

        // Llenado gradual en el envase (la base representa hasta el 65% del volumen)
        const ratio = PLC.timers.T1.ET / PLC.timers.T1.PT;
        PLC.plant.carboyLevelPct = Math.min(65, ratio * 65);
        PLC.plant.carboyVolumeMl = Math.round(ratio * 650);

        // Consumo leve en Tanque 1
        if (PLC.plant.t1LevelPct > 15) {
          PLC.plant.t1LevelPct -= dtSeconds * 0.4;
        }

      } else {
        PLC.outputs.Q00_ValveBase = false;

        // ETAPA 2: CONCENTRADO ACTIVO (Q0.1) & TON T2 (Hogar 2s) o TON T3 (Ind 5s)
        const activeTimer = (I05 === 0) ? PLC.timers.T2 : PLC.timers.T3;
        
        if (!activeTimer.Q) {
          PLC.plant.activePhase = 'CONC';
          PLC.plant.phaseMessage = (I05 === 0)
            ? 'DOSIFICANDO CONCENTRADO ACTIVO (EV2 Q0.1 - RECETA HOGAR 2.0s)...'
            : 'DOSIFICANDO CONCENTRADO ACTIVO (EV2 Q0.1 - RECETA INDUSTRIAL 5.0s)...';
          PLC.outputs.Q01_ValveConc = true;
          PLC.outputs.Q02_MotorMixer = false;

          activeTimer.IN = true;
          activeTimer.ET += dtSeconds;
          if (activeTimer.ET >= activeTimer.PT) {
            activeTimer.ET = activeTimer.PT;
            activeTimer.Q = true;
            PLC.outputs.Q01_ValveConc = false;
            playSound('valve_on');
          }

          // Aumento del volumen de concentrado hasta el 100%
          const ratio = activeTimer.ET / activeTimer.PT;
          PLC.plant.carboyLevelPct = 65 + (ratio * 35);
          PLC.plant.carboyVolumeMl = 650 + Math.round(ratio * 350);

          // Consumo leve en Tanque 2
          if (PLC.plant.t2LevelPct > 15) {
            PLC.plant.t2LevelPct -= dtSeconds * 0.35;
          }

        } else {
          PLC.outputs.Q01_ValveConc = false;

          // ETAPA 3: MOTOR AGITADOR HOMOGENEIZADOR (Q0.2) & TON T4
          // PT: 3.0s (Hogar) o 4.0s (Industrial)
          PLC.timers.T4.PT = (I05 === 0) ? 3.0 : 4.0;

          if (!PLC.timers.T4.Q) {
            PLC.plant.activePhase = 'MIX';
            PLC.plant.phaseMessage = `HOMOGENEIZANDO FÓRMULA QUÍMICA (MTR1 Q0.2 - ${PLC.timers.T4.PT.toFixed(1)}s)...`;
            PLC.outputs.Q02_MotorMixer = true;

            PLC.timers.T4.IN = true;
            PLC.timers.T4.ET += dtSeconds;

            if (Math.floor(PLC.timers.T4.ET * 4) % 2 === 0) {
              playSound('mixer_hum');
            }

            if (PLC.timers.T4.ET >= PLC.timers.T4.PT) {
              PLC.timers.T4.ET = PLC.timers.T4.PT;
              PLC.timers.T4.Q = true;
              PLC.outputs.Q02_MotorMixer = false;
            }

          } else {
            // ETAPA 4: FIN DE CICLO, CTU C1 Y MEMORIA POKA-YOKE M0.4 (NETWORK 5)
            PLC.outputs.Q02_MotorMixer = false;
            PLC.memory.M00_SystemRun = false; // Desenergiza marcha
            PLC.memory.M04_PokaYokeLock = true; // ENCLAVAMIENTO POKA-YOKE
            PLC.outputs.Q03_LightReady = true;  // Piloto Verde
            PLC.plant.activePhase = 'DONE';
            PLC.plant.phaseMessage = '¡CICLO COMPLETADO CON ÉXITO! RETIRE EL BIDÓN TERMINADO';

            // Incrementar contador CTU C1
            PLC.counters.C1.CV++;
            PLC.plant.totalLitersDispensed += 1.0;
            playSound('chime_done');
            logEvent('FIN_CICLO', `Llenado terminado. Bidón #${PLC.counters.C1.CV} listo. Bloqueo Poka-Yoke activado.`);
          }
        }
      }
    } else {
      // Estado de Reposo o Fuera de Marcha
      PLC.outputs.Q00_ValveBase = false;
      PLC.outputs.Q01_ValveConc = false;
      PLC.outputs.Q02_MotorMixer = false;

      if (!faultDetected && !PLC.memory.M04_PokaYokeLock && I02) {
        PLC.plant.activePhase = 'IDLE';
        PLC.plant.phaseMessage = 'BIDÓN DETECTADO: LISTO PARA INICIAR. PULSE BOTÓN VERDE "START"';
      } else if (!faultDetected && !I02) {
        PLC.plant.activePhase = 'IDLE';
        PLC.plant.phaseMessage = 'SISTEMA LISTO: COLOQUE UN BIDÓN VACÍO EN LA BASE RECEPTORA';
      }
    }

    // FASE 7: ACTUALIZACIÓN DE INTERFAZ GRÁFICA Y SVG
    renderUI();
  }

  function resetAllTimers() {
    PLC.timers.T1.IN = false;
    PLC.timers.T1.ET = 0;
    PLC.timers.T1.Q = false;

    PLC.timers.T2.IN = false;
    PLC.timers.T2.ET = 0;
    PLC.timers.T2.Q = false;

    PLC.timers.T3.IN = false;
    PLC.timers.T3.ET = 0;
    PLC.timers.T3.Q = false;

    PLC.timers.T4.IN = false;
    PLC.timers.T4.ET = 0;
    PLC.timers.T4.Q = false;
  }

  function logEvent(tipo, detalle) {
    const timestamp = new Date().toLocaleTimeString();
    productionLog.unshift({
      time: timestamp,
      type: tipo,
      desc: detalle,
      counter: PLC.counters.C1.CV,
      recipe: PLC.inputs.I05_Recipe === 0 ? 'Fórmula Hogar' : 'Fórmula Industrial'
    });
    if (productionLog.length > 50) productionLog.pop();
  }

  // ==========================================================================
  // 4. RENDERIZADO VISUAL EN TIEMPO REAL (SVG + DOM)
  // ==========================================================================
  function renderUI() {
    // 1. Barra de Estado Superior
    const badge = document.getElementById('plcStatusBadge');
    const badgeText = document.getElementById('plcStatusText');
    if (badge && badgeText) {
      if (PLC.runMode === 'ALARM') {
        badge.className = 'plc-status-badge status-alarm';
        badgeText.textContent = 'PLC ALARM';
      } else if (PLC.memory.M00_SystemRun) {
        badge.className = 'plc-status-badge status-run';
        badgeText.textContent = 'PLC RUN (CICLO ACTIVO)';
      } else {
        badge.className = 'plc-status-badge status-run';
        badgeText.textContent = 'PLC RUN (STANDBY)';
      }
    }

    const recMetric = document.getElementById('metricActiveRecipe');
    if (recMetric) {
      recMetric.textContent = PLC.inputs.I05_Recipe === 0 ? 'Fórmula Hogar (1L)' : 'Fórmula Industrial (1L)';
    }

    // 2. Display Digital OLED en Zona B
    const dispMessage = document.getElementById('dispMessage');
    const dispBadge = document.getElementById('dispStepBadge');
    const dispProgressBar = document.getElementById('dispProgressBar');
    const dispStageTimer = document.getElementById('dispStageTimer');
    const dispCounter = document.getElementById('dispCounter');
    const dispTotalVolume = document.getElementById('dispTotalVolume');

    if (dispMessage) dispMessage.textContent = PLC.plant.phaseMessage;
    if (dispCounter) dispCounter.textContent = `${PLC.counters.C1.CV} bidones`;
    if (dispTotalVolume) dispTotalVolume.textContent = `${PLC.plant.totalLitersDispensed.toFixed(2)} L`;

    // Cálculo de progreso y timer actual
    let progress = 0;
    let timerVal = '0.0 s';
    let stepName = 'PASO 0 / STANDBY';

    if (PLC.plant.activePhase === 'BASE') {
      stepName = 'PASO 1 / BASE AGUA';
      progress = (PLC.timers.T1.ET / PLC.timers.T1.PT) * 33;
      timerVal = `${PLC.timers.T1.ET.toFixed(1)}s / ${PLC.timers.T1.PT.toFixed(1)}s`;
    } else if (PLC.plant.activePhase === 'CONC') {
      stepName = 'PASO 2 / CONCENTRADO';
      const t = (PLC.inputs.I05_Recipe === 0) ? PLC.timers.T2 : PLC.timers.T3;
      progress = 33 + ((t.ET / t.PT) * 33);
      timerVal = `${t.ET.toFixed(1)}s / ${t.PT.toFixed(1)}s`;
    } else if (PLC.plant.activePhase === 'MIX') {
      stepName = 'PASO 3 / HOMOGENEIZACIÓN';
      progress = 66 + ((PLC.timers.T4.ET / PLC.timers.T4.PT) * 34);
      timerVal = `${PLC.timers.T4.ET.toFixed(1)}s / ${PLC.timers.T4.PT.toFixed(1)}s`;
    } else if (PLC.plant.activePhase === 'DONE') {
      stepName = 'PASO 4 / RETIRO POKA-YOKE';
      progress = 100;
      timerVal = 'OK';
    } else if (PLC.runMode === 'ALARM') {
      stepName = 'ALARMA / PARO';
      progress = 0;
      timerVal = 'ERR';
    }

    if (dispBadge) dispBadge.textContent = stepName;
    if (dispProgressBar) dispProgressBar.style.width = `${progress}%`;
    if (dispStageTimer) dispStageTimer.textContent = timerVal;

    // 3. Planta 2D (Zona A) - Tanques, Niveles, Tuberías y Envase
    renderPlantSVG();

    // 4. LEDs Físicos del PLC (Rack 0)
    renderIoLeds();

    // 5. Visor de Ladder Dinámico (Zona C)
    renderLadder();

    // 6. Diagrama de Compuertas Lógicas (Pestaña 2)
    renderLogicDiagram();
  }

  function renderPlantSVG() {
    // Tanque 1: Base Agua
    const t1HeightMax = 119;
    const t1Height = (PLC.plant.t1LevelPct / 100) * t1HeightMax;
    const t1Y = 8 + (t1HeightMax - t1Height);
    const t1Rect = document.getElementById('t1LiquidRect');
    const t1Text = document.getElementById('t1LevelText');
    const sensorT1 = document.getElementById('sensorT1Dot');
    if (t1Rect) {
      t1Rect.setAttribute('y', t1Y);
      t1Rect.setAttribute('height', t1Height);
    }
    if (t1Text) {
      t1Text.textContent = `${Math.round(PLC.plant.t1LevelPct)}% (${Math.round(PLC.plant.t1LevelPct * 5)} L)`;
    }
    if (sensorT1) {
      sensorT1.setAttribute('fill', PLC.inputs.I03_LevelT1Ok ? '#16A34A' : '#DC2626');
    }

    // Tanque 2: Concentrado
    const t2HeightMax = 119;
    const t2Height = (PLC.plant.t2LevelPct / 100) * t2HeightMax;
    const t2Y = 8 + (t2HeightMax - t2Height);
    const t2Rect = document.getElementById('t2LiquidRect');
    const t2Text = document.getElementById('t2LevelText');
    const sensorT2 = document.getElementById('sensorT2Dot');
    if (t2Rect) {
      t2Rect.setAttribute('y', t2Y);
      t2Rect.setAttribute('height', t2Height);
    }
    if (t2Text) {
      t2Text.textContent = `${Math.round(PLC.plant.t2LevelPct)}% (${Math.round(PLC.plant.t2LevelPct * 2.5)} L)`;
    }
    if (sensorT2) {
      sensorT2.setAttribute('fill', PLC.inputs.I04_LevelT2Ok ? '#16A34A' : '#DC2626');
    }

    // Tuberías y Electroválvulas EV1 y EV2
    const pipe1 = document.getElementById('pipeFlow1');
    const valve1Shape = document.getElementById('valve1Shape');
    const valve1Led = document.getElementById('valve1Led');
    const valve1Txt = document.getElementById('valve1StatusText');
    if (PLC.outputs.Q00_ValveBase) {
      if (pipe1) pipe1.className.baseVal = 'pipe-flowing';
      if (valve1Shape) valve1Shape.setAttribute('fill', 'url(#gradValveActive)');
      if (valve1Led) valve1Led.setAttribute('fill', '#22C55E');
      if (valve1Txt) { valve1Txt.textContent = 'ABIERTA'; valve1Txt.setAttribute('fill', '#16A34A'); }
    } else {
      if (pipe1) pipe1.className.baseVal = 'pipe-empty';
      if (valve1Shape) valve1Shape.setAttribute('fill', 'url(#gradValveInactive)');
      if (valve1Led) valve1Led.setAttribute('fill', '#94A3B8');
      if (valve1Txt) { valve1Txt.textContent = 'CERRADA'; valve1Txt.setAttribute('fill', '#64748B'); }
    }

    const pipe2 = document.getElementById('pipeFlow2');
    const valve2Shape = document.getElementById('valve2Shape');
    const valve2Led = document.getElementById('valve2Led');
    const valve2Txt = document.getElementById('valve2StatusText');
    if (PLC.outputs.Q01_ValveConc) {
      if (pipe2) pipe2.className.baseVal = 'pipe-flowing';
      if (valve2Shape) valve2Shape.setAttribute('fill', 'url(#gradValveActive)');
      if (valve2Led) valve2Led.setAttribute('fill', '#22C55E');
      if (valve2Txt) { valve2Txt.textContent = 'ABIERTA'; valve2Txt.setAttribute('fill', '#16A34A'); }
    } else {
      if (pipe2) pipe2.className.baseVal = 'pipe-empty';
      if (valve2Shape) valve2Shape.setAttribute('fill', 'url(#gradValveInactive)');
      if (valve2Led) valve2Led.setAttribute('fill', '#94A3B8');
      if (valve2Txt) { valve2Txt.textContent = 'CERRADA'; valve2Txt.setAttribute('fill', '#64748B'); }
    }

    // Motor Agitador MTR1 (Q0.2)
    const agitator = document.getElementById('agitatorBlades');
    const mixerLed = document.getElementById('mixerLed');
    const mixerTxt = document.getElementById('mixerStatusText');
    if (PLC.outputs.Q02_MotorMixer) {
      if (agitator) agitator.classList.add('spinning-motor');
      if (mixerLed) mixerLed.setAttribute('fill', '#D97706');
      if (mixerTxt) { mixerTxt.textContent = 'AGITANDO...'; mixerTxt.setAttribute('fill', '#D97706'); }
    } else {
      if (agitator) agitator.classList.remove('spinning-motor');
      if (mixerLed) mixerLed.setAttribute('fill', '#94A3B8');
      if (mixerTxt) { mixerTxt.textContent = 'AGITADOR OFF'; mixerTxt.setAttribute('fill', '#64748B'); }
    }

    // Chorro de llenado en boquilla
    const stream = document.getElementById('fillingStream');
    if (stream) {
      if (PLC.outputs.Q00_ValveBase || PLC.outputs.Q01_ValveConc) {
        stream.className.baseVal = 'dispense-on';
        stream.setAttribute('stroke', PLC.outputs.Q00_ValveBase ? '#38BDF8' : '#2563EB');
      } else {
        stream.className.baseVal = 'dispense-off';
      }
    }

    // Sensor óptico de bidón I0.2 y haz láser
    const laser = document.getElementById('laserBeam');
    const sensorLed = document.getElementById('sensorPresenceLed');
    const containerGroup = document.getElementById('containerGroup');
    const btnPlaceCarboy = document.getElementById('btnPlaceCarboy');
    const btnRemoveCarboy = document.getElementById('btnRemoveCarboy');

    if (PLC.inputs.I02_CarboyPresent) {
      if (laser) {
        laser.setAttribute('x2', '80');
        laser.setAttribute('stroke', '#16A34A');
        laser.setAttribute('stroke-width', '2.5');
      }
      if (sensorLed) sensorLed.setAttribute('fill', '#16A34A');
      if (containerGroup) containerGroup.style.display = 'block';
      if (btnPlaceCarboy) btnPlaceCarboy.disabled = true;
      if (btnRemoveCarboy) btnRemoveCarboy.disabled = false;
    } else {
      if (laser) {
        laser.setAttribute('x2', '200');
        laser.setAttribute('stroke', '#EF4444');
        laser.setAttribute('stroke-width', '1.5');
      }
      if (sensorLed) sensorLed.setAttribute('fill', '#EF4444');
      if (containerGroup) containerGroup.style.display = 'none';
      if (btnPlaceCarboy) btnPlaceCarboy.disabled = false;
      if (btnRemoveCarboy) btnRemoveCarboy.disabled = true;
    }

    // Líquido y Menisco dentro del Bidón
    const carboyLiquid = document.getElementById('carboyLiquid');
    const carboyMeniscus = document.getElementById('carboyMeniscus');
    const carboyVolText = document.getElementById('carboyVolumeText');

    if (carboyLiquid) {
      const maxHeight = 70; // altura interna de 38 a 108
      const currentHeight = (PLC.plant.carboyLevelPct / 100) * maxHeight;
      const currentY = 108 - currentHeight;
      carboyLiquid.setAttribute('y', currentY);
      carboyLiquid.setAttribute('height', currentHeight);

      // Color dinámico según la fase: más claro con agua pura, azul profundo con concentrado
      if (PLC.plant.carboyLevelPct <= 65) {
        carboyLiquid.setAttribute('fill', 'url(#gradWater)');
      } else {
        carboyLiquid.setAttribute('fill', 'url(#gradFinishedLiquid)');
      }

      if (carboyMeniscus) {
        carboyMeniscus.setAttribute('y1', currentY);
        carboyMeniscus.setAttribute('y2', currentY);
        carboyMeniscus.style.opacity = currentHeight > 2 ? '0.8' : '0';
      }
    }
    if (carboyVolText) {
      carboyVolText.textContent = `${PLC.plant.carboyVolumeMl} ml`;
    }

    // Baliza luminosa (Piloto Verde Q0.3 / Baliza Roja Q0.4)
    const beaconGrn = document.getElementById('beaconGreen');
    const beaconRed = document.getElementById('beaconRed');
    if (beaconGrn) {
      beaconGrn.setAttribute('opacity', PLC.outputs.Q03_LightReady ? '1' : '0.25');
      if (PLC.outputs.Q03_LightReady) beaconGrn.setAttribute('filter', 'url(#glowFlow)');
      else beaconGrn.removeAttribute('filter');
    }
    if (beaconRed) {
      beaconRed.setAttribute('opacity', PLC.outputs.Q04_BeaconAlarm ? '1' : '0.25');
      if (PLC.outputs.Q04_BeaconAlarm) beaconRed.setAttribute('filter', 'url(#glowFlow)');
      else beaconRed.removeAttribute('filter');
    }
  }

  function renderIoLeds() {
    setLed('led-I0.0', PLC.inputs.I00_Start);
    setLed('led-I0.1', PLC.inputs.I01_Stop);
    setLed('led-I0.2', PLC.inputs.I02_CarboyPresent);
    setLed('led-I0.3', PLC.inputs.I03_LevelT1Ok);
    setLed('led-I0.4', PLC.inputs.I04_LevelT2Ok);
    setLed('led-I0.5', PLC.inputs.I05_Recipe === 1);
    setLed('led-I0.6', PLC.inputs.I06_EStopOk);
    setLed('led-I0.7', PLC.inputs.I07_Reset);

    setLed('led-Q0.0', PLC.outputs.Q00_ValveBase);
    setLed('led-Q0.1', PLC.outputs.Q01_ValveConc);
    setLed('led-Q0.2', PLC.outputs.Q02_MotorMixer);
    setLed('led-Q0.3', PLC.outputs.Q03_LightReady);
    setLed('led-Q0.4', PLC.outputs.Q04_BeaconAlarm, true);
  }

  function setLed(id, isActive, isAlarm = false) {
    const item = document.getElementById(id);
    if (!item) return;
    const bulb = item.querySelector('.led-bulb');
    if (!bulb) return;

    if (isActive) {
      bulb.className = isAlarm ? 'led-bulb led-alarm-on' : 'led-bulb led-on';
    } else {
      bulb.className = 'led-bulb led-off';
    }
  }

  // ==========================================================================
  // 5. VISOR DINÁMICO DE LÓGICA LADDER (ZONA C)
  // ==========================================================================
  function renderLadder() {
    const I00 = PLC.inputs.I00_Start;
    const I01 = PLC.inputs.I01_Stop; // NC
    const I02 = PLC.inputs.I02_CarboyPresent;
    const I03 = PLC.inputs.I03_LevelT1Ok;
    const I04 = PLC.inputs.I04_LevelT2Ok;
    const I05 = PLC.inputs.I05_Recipe;
    const I06 = PLC.inputs.I06_EStopOk;
    const M00 = PLC.memory.M00_SystemRun;
    const M04 = PLC.memory.M04_PokaYokeLock;

    // Network 1: Permisivos y Enclavamiento M0.0
    setLadderElement('elem_I00', I00);
    setLadderElement('elem_M00_ret', M00);
    setLadderElement('elem_I01', I01); // NC conduce cuando I0.1 es 1 (no oprimido)
    setLadderElement('elem_I02', I02);
    setLadderElement('elem_I03', I03);
    setLadderElement('elem_I04', I04);
    setLadderElement('elem_I06', I06);
    setLadderElement('elem_M04_lock', !M04); // NC conduce cuando M0.4 es 0
    setLadderElement('elem_M00_coil', M00);

    // Network 2: Base Agua Q0.0 y TON T1
    setLadderElement('elem_net2_M00', M00);
    setLadderElement('elem_net2_T1', !PLC.timers.T1.Q && M00);
    setLadderElement('elem_Q00_coil', PLC.outputs.Q00_ValveBase);
    updateLadderTimerBlock('block_T1', 't1_in', 't1_et', PLC.timers.T1);

    // Network 3: Concentrado Q0.1 y TON T2 / T3
    setLadderElement('elem_net3_M00', M00);
    setLadderElement('elem_net3_T1DN', PLC.timers.T1.Q);
    setLadderElement('elem_net3_I05_hogar', I05 === 0);
    setLadderElement('elem_net3_T2DN', !PLC.timers.T2.Q);
    setLadderElement('elem_net3_I05_ind', I05 === 1);
    setLadderElement('elem_net3_T3DN', !PLC.timers.T3.Q);
    setLadderElement('elem_Q01_coil', PLC.outputs.Q01_ValveConc);
    updateLadderTimerBlock('block_T2', null, 't2_et', PLC.timers.T2);
    updateLadderTimerBlock('block_T3', null, 't3_et', PLC.timers.T3);

    // Network 4: Motor Mezclador Q0.2 y TON T4
    setLadderElement('elem_net4_M00', M00);
    setLadderElement('elem_net4_T2DN', PLC.timers.T2.Q);
    setLadderElement('elem_net4_T3DN', PLC.timers.T3.Q);
    setLadderElement('elem_net4_T4DN', !PLC.timers.T4.Q && (PLC.timers.T2.Q || PLC.timers.T3.Q));
    setLadderElement('elem_Q02_coil', PLC.outputs.Q02_MotorMixer);
    updateLadderTimerBlock('block_T4', null, 't4_et', PLC.timers.T4);
    const t4Pt = document.getElementById('t4_pt');
    if (t4Pt) t4Pt.textContent = `${PLC.timers.T4.PT.toFixed(1)}s`;

    // Network 5: Fin de Ciclo, Luz Verde Q0.3, Poka-Yoke M0.4 y CTU C1
    const endCondition = PLC.timers.T4.Q && I02;
    setLadderElement('elem_net5_T4DN', PLC.timers.T4.Q);
    setLadderElement('elem_net5_I02', I02);
    setLadderElement('elem_Q03_coil', PLC.outputs.Q03_LightReady);
    setLadderElement('elem_M04_set', M04);
    setLadderElement('elem_sub_I02', !I02);
    setLadderElement('elem_M04_reset', !M04 && !I02);

    const c1Cv = document.getElementById('c1_cv');
    const c1Cu = document.getElementById('c1_cu');
    if (c1Cv) c1Cv.textContent = PLC.counters.C1.CV;
    if (c1Cu) c1Cu.textContent = PLC.timers.T4.Q ? '1' : '0';

    // Network 6: Alarmas Q0.4
    setLadderElement('elem_net6_I03', !I03);
    setLadderElement('elem_net6_I04', !I04);
    setLadderElement('elem_net6_I06', !I06);
    setLadderElement('elem_Q04_coil', PLC.outputs.Q04_BeaconAlarm);

    // Network 7: Reset
    setLadderElement('elem_net7_I07', PLC.inputs.I07_Reset);
    setLadderElement('elem_C1_reset', PLC.inputs.I07_Reset);
  }

  function setLadderElement(id, isActive) {
    const el = document.getElementById(id);
    if (!el) return;
    if (isActive) {
      el.classList.add('active-power');
    } else {
      el.classList.remove('active-power');
    }
  }

  function updateLadderTimerBlock(blockId, inId, etId, timerObj) {
    const block = document.getElementById(blockId);
    if (block) {
      if (timerObj.IN && !timerObj.Q) {
        block.classList.add('block-active');
      } else {
        block.classList.remove('block-active');
      }
    }
    if (inId) {
      const inEl = document.getElementById(inId);
      if (inEl) inEl.textContent = timerObj.IN ? '1' : '0';
    }
    if (etId) {
      const etEl = document.getElementById(etId);
      if (etEl) etEl.textContent = `${timerObj.ET.toFixed(1)}s`;
    }
  }

  // ==========================================================================
  // 6. DIAGRAMA DE COMPUERTAS LÓGICAS (PESTAÑA 2)
  // ==========================================================================
  function renderLogicDiagram() {
    if (PLC.logicMode !== 'SYNC') return; // En modo manual el usuario interactúa libremente

    // Entradas
    setLogicInputBox('box_I00', 'port_I00', PLC.inputs.I00_Start);
    setLogicInputBox('box_I01', 'port_I01', PLC.inputs.I01_Stop);
    setLogicInputBox('box_I02', 'port_I02', PLC.inputs.I02_CarboyPresent);
    setLogicInputBox('box_I03', 'port_I03', PLC.inputs.I03_LevelT1Ok);
    setLogicInputBox('box_I04', 'port_I04', PLC.inputs.I04_LevelT2Ok);
    setLogicInputBox('box_I05', 'port_I05', PLC.inputs.I05_Recipe === 1);
    setLogicInputBox('box_I06', 'port_I06', PLC.inputs.I06_EStopOk);
    setLogicInputBox('box_I07', 'port_I07', PLC.inputs.I07_Reset);

    // Salidas
    setLogicOutputBox('box_Q00', PLC.outputs.Q00_ValveBase);
    setLogicOutputBox('box_Q01', PLC.outputs.Q01_ValveConc);
    setLogicOutputBox('box_Q02', PLC.outputs.Q02_MotorMixer);
    setLogicOutputBox('box_Q03', PLC.outputs.Q03_LightReady);
    setLogicOutputBox('box_Q04', PLC.outputs.Q04_BeaconAlarm, true);

    // Cables de interconexión
    setLogicWire('wire_M00_T1', PLC.memory.M00_SystemRun);
    setLogicWire('wire_T1_Q00', PLC.outputs.Q00_ValveBase);
    setLogicWire('wire_T1DN_T2', PLC.timers.T1.Q);
    setLogicWire('wire_T1DN_T3', PLC.timers.T1.Q);
    setLogicWire('wire_MUX_Q01', PLC.outputs.Q01_ValveConc);
    setLogicWire('wire_Tconc_T4', PLC.timers.T2.Q || PLC.timers.T3.Q);
    setLogicWire('wire_T4_Q02', PLC.outputs.Q02_MotorMixer);
    setLogicWire('wire_T4DN_M04', PLC.timers.T4.Q);
    setLogicWire('wire_M04_Q03', PLC.outputs.Q03_LightReady);
    setLogicWire('wire_Alarm_Q04', PLC.outputs.Q04_BeaconAlarm);
  }

  function setLogicInputBox(boxId, portId, active) {
    const box = document.getElementById(boxId);
    const port = document.getElementById(portId);
    if (box) {
      if (active) box.classList.add('active');
      else box.classList.remove('active');
    }
    if (port) {
      if (active) port.classList.add('active');
      else port.classList.remove('active');
    }
  }

  function setLogicOutputBox(boxId, active, isAlarm = false) {
    const box = document.getElementById(boxId);
    if (!box) return;
    if (active) {
      box.className = isAlarm ? 'out-box active-alarm' : 'out-box active';
    } else {
      box.className = 'out-box';
    }
  }

  function setLogicWire(wireId, active) {
    const wire = document.getElementById(wireId);
    if (!wire) return;
    if (active) {
      wire.className.baseVal = 'logic-wire wire-high';
    } else {
      wire.className.baseVal = 'logic-wire wire-low';
    }
  }

  // ==========================================================================
  // 7. CONTROLADORES DE EVENTOS Y VINCULACIÓN CON INTERFAZ (LISTENERS)
  // ==========================================================================
  function setupEventListeners() {
    // Pestañas Principales
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        const pane = document.getElementById(targetTab);
        if (pane) pane.classList.add('active');
        playSound('click');
      });
    });

    // Control de Velocidad (1x / 2x)
    const speedButtons = document.querySelectorAll('.btn-speed');
    speedButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        speedButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        PLC.timeScale = parseFloat(btn.getAttribute('data-speed'));
        playSound('click');
      });
    });

    // Botón START (I0.0)
    const btnStart = document.getElementById('btnStart');
    if (btnStart) {
      btnStart.addEventListener('click', () => {
        PLC.inputs.I00_Start = true;
        playSound('click');
      });
    }

    // Botón STOP (I0.1)
    const btnStop = document.getElementById('btnStop');
    if (btnStop) {
      btnStop.addEventListener('click', () => {
        PLC.inputs.I01_Stop = false; // Pulso de paro
        PLC.memory.M00_SystemRun = false;
        playSound('alarm');
        logEvent('STOP', 'Pulsador Stop presionado manualmente por operario (I0.1).');
        setTimeout(() => { PLC.inputs.I01_Stop = true; }, 300);
      });
    }

    // Selector de Receta (I0.5)
    const knob = document.getElementById('recipeSelectorKnob');
    const lblHogar = document.getElementById('lblRecHogar');
    const lblInd = document.getElementById('lblRecInd');
    const valI05 = document.getElementById('valI05');
    const recBox = document.getElementById('recipeDetailsBox');

    function toggleRecipe() {
      if (PLC.memory.M00_SystemRun) {
        alert("Atención: No se puede cambiar la receta durante un ciclo de dosificación activo.");
        return;
      }
      PLC.inputs.I05_Recipe = (PLC.inputs.I05_Recipe === 0) ? 1 : 0;
      playSound('click');

      if (PLC.inputs.I05_Recipe === 0) {
        knob.className = 'dial-knob pos-0';
        if (lblHogar) lblHogar.className = 'dial-lbl active-rec';
        if (lblInd) lblInd.className = 'dial-lbl';
        if (valI05) valI05.textContent = '0 (HOGAR)';
        if (recBox) {
          recBox.innerHTML = '<div class="rec-name">Fórmula Hogar (1.0 L)</div><div class="rec-steps">Base 4.0s | Conc 2.0s | Mezcla 3.0s</div>';
        }
      } else {
        knob.className = 'dial-knob pos-1';
        if (lblHogar) lblHogar.className = 'dial-lbl';
        if (lblInd) lblInd.className = 'dial-lbl active-rec';
        if (valI05) valI05.textContent = '1 (INDUSTRIAL)';
        if (recBox) {
          recBox.innerHTML = '<div class="rec-name">Fórmula Industrial (1.0 L)</div><div class="rec-steps">Base 4.0s | Conc 5.0s | Mezcla 4.0s</div>';
        }
      }
    }
    if (knob) knob.addEventListener('click', toggleRecipe);

    // Paro de Emergencia E-STOP (I0.6)
    const btnEstop = document.getElementById('btnEstop');
    const estopText = document.getElementById('estopStatusText');
    if (btnEstop) {
      btnEstop.addEventListener('click', () => {
        PLC.inputs.I06_EStopOk = !PLC.inputs.I06_EStopOk;
        playSound('alarm');
        if (!PLC.inputs.I06_EStopOk) {
          btnEstop.classList.add('latched');
          if (estopText) {
            estopText.textContent = '¡DISPARADO! (Abierto)';
            estopText.className = 'estop-status-text alarm';
          }
          logEvent('EMERGENCIA', 'Paro de Emergencia enclavado. Todas las salidas cortadas inmediatamente.');
        } else {
          btnEstop.classList.remove('latched');
          if (estopText) {
            estopText.textContent = 'SEGURO (Cerrado)';
            estopText.className = 'estop-status-text';
          }
          logEvent('EMERGENCIA', 'Paro de Emergencia rearmado y girado a posición segura.');
        }
      });
    }

    // Reset Contador / Alarmas (I0.7)
    const btnReset = document.getElementById('btnReset');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        PLC.inputs.I07_Reset = true;
        playSound('click');
      });
    }

    // Acciones de Tanques (Vaciar / Rellenar)
    const btnDrainT1 = document.getElementById('btnDrainT1');
    const btnFillT1 = document.getElementById('btnFillT1');
    const btnDrainT2 = document.getElementById('btnDrainT2');
    const btnFillT2 = document.getElementById('btnFillT2');

    if (btnDrainT1) {
      btnDrainT1.addEventListener('click', () => {
        PLC.plant.t1LevelPct = 12; // < 15%
        PLC.inputs.I03_LevelT1Ok = false;
        playSound('alarm');
        logEvent('FALLA_NIVEL', 'Tanque 1 (Base) vaciado manualmente por debajo del 15%. Boya I0.3 abierta.');
      });
    }
    if (btnFillT1) {
      btnFillT1.addEventListener('click', () => {
        PLC.plant.t1LevelPct = 100;
        PLC.inputs.I03_LevelT1Ok = true;
        playSound('click');
        logEvent('INVENTARIO', 'Tanque 1 rellenado al 100%.');
      });
    }
    if (btnDrainT2) {
      btnDrainT2.addEventListener('click', () => {
        PLC.plant.t2LevelPct = 10; // < 15%
        PLC.inputs.I04_LevelT2Ok = false;
        playSound('alarm');
        logEvent('FALLA_NIVEL', 'Tanque 2 (Concentrado) vaciado por debajo del 15%. Boya I0.4 abierta.');
      });
    }
    if (btnFillT2) {
      btnFillT2.addEventListener('click', () => {
        PLC.plant.t2LevelPct = 100;
        PLC.inputs.I04_LevelT2Ok = true;
        playSound('click');
        logEvent('INVENTARIO', 'Tanque 2 rellenado al 100%.');
      });
    }

    // Acciones de Operario con el Bidón (Poka-Yoke)
    const btnPlaceCarboy = document.getElementById('btnPlaceCarboy');
    const btnRemoveCarboy = document.getElementById('btnRemoveCarboy');

    if (btnPlaceCarboy) {
      btnPlaceCarboy.addEventListener('click', () => {
        PLC.inputs.I02_CarboyPresent = true;
        PLC.plant.carboyLevelPct = 0;
        PLC.plant.carboyVolumeMl = 0;
        playSound('click');
        logEvent('OPERARIO', 'Bidón vacío colocado en la base de recepción. Sensor óptico I0.2 activo.');
      });
    }

    if (btnRemoveCarboy) {
      btnRemoveCarboy.addEventListener('click', () => {
        PLC.inputs.I02_CarboyPresent = false;
        playSound('click');
        logEvent('OPERARIO', 'Bidón lleno retirado de la estación por el operario.');
      });
    }

    // Modo de Compuertas Lógicas (Sincronizado vs Manual)
    const btnSyncSim = document.getElementById('btnSyncSim');
    const btnManualLogic = document.getElementById('btnManualLogic');

    if (btnSyncSim && btnManualLogic) {
      btnSyncSim.addEventListener('click', () => {
        PLC.logicMode = 'SYNC';
        btnSyncSim.classList.add('active');
        btnManualLogic.classList.remove('active');
        playSound('click');
      });

      btnManualLogic.addEventListener('click', () => {
        PLC.logicMode = 'MANUAL';
        btnManualLogic.classList.add('active');
        btnSyncSim.classList.remove('active');
        playSound('click');
        alert("Modo Pruebas Manuales activo: Ahora puede hacer clic directamente en las cajas de entrada I0.0 - I0.7 en el diagrama para probar el circuito lógico de forma independiente.");
      });
    }

    // Nodos de entrada interactivos en el SVG de compuertas lógicas (para pruebas manuales)
    const logicInputNodes = [
      { id: 'node_I00', prop: 'I00_Start' },
      { id: 'node_I01', prop: 'I01_Stop' },
      { id: 'node_I02', prop: 'I02_CarboyPresent' },
      { id: 'node_I03', prop: 'I03_LevelT1Ok' },
      { id: 'node_I04', prop: 'I04_LevelT2Ok' },
      { id: 'node_I05', prop: 'I05_Recipe' },
      { id: 'node_I06', prop: 'I06_EStopOk' },
      { id: 'node_I07', prop: 'I07_Reset' }
    ];

    logicInputNodes.forEach(item => {
      const el = document.getElementById(item.id);
      if (el) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
          if (PLC.logicMode === 'MANUAL') {
            if (item.prop === 'I05_Recipe') {
              PLC.inputs[item.prop] = PLC.inputs[item.prop] === 0 ? 1 : 0;
            } else {
              PLC.inputs[item.prop] = !PLC.inputs[item.prop];
            }
            playSound('click');
            renderUI();
          }
        });
      }
    });

    // Copiar código C++
    const btnCopy = document.getElementById('btnCopyCode');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const code = document.getElementById('codeCpp').textContent;
        navigator.clipboard.writeText(code).then(() => {
          const originalText = btnCopy.textContent;
          btnCopy.textContent = '✅ ¡Código Copiado!';
          playSound('click');
          setTimeout(() => { btnCopy.textContent = originalText; }, 2000);
        }).catch(err => {
          console.error("Error al copiar:", err);
        });
      });
    }

    // Audio Mute/Unmute
    const btnSound = document.getElementById('btnSoundToggle');
    const soundIcon = document.getElementById('soundIcon');
    if (btnSound && soundIcon) {
      btnSound.addEventListener('click', () => {
        PLC.audioEnabled = !PLC.audioEnabled;
        soundIcon.textContent = PLC.audioEnabled ? '🔊' : '🔇';
        if (PLC.audioEnabled) playSound('click');
      });
    }

    // Modo Pantalla Completa
    const btnFullscreen = document.getElementById('btnFullscreen');
    if (btnFullscreen) {
      btnFullscreen.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(err => {
            console.warn("Fullscreen no autorizado:", err);
          });
        } else {
          document.exitFullscreen();
        }
      });
    }

    // Modal de Certificado de Trazabilidad de Auditoría
    const btnExportLog = document.getElementById('btnExportLog');
    const auditModal = document.getElementById('auditModal');
    const btnCloseModal = document.getElementById('btnCloseModal');
    const btnCloseReport = document.getElementById('btnCloseReport');
    const btnPrintReport = document.getElementById('btnPrintReport');
    const reportBody = document.getElementById('auditReportContent');

    if (btnExportLog && auditModal && reportBody) {
      btnExportLog.addEventListener('click', () => {
        const dateStr = new Date().toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        const timeStr = new Date().toLocaleTimeString();

        let logHtml = `
          <div style="font-family:'Plus Jakarta Sans',sans-serif; color:#0F172A;">
            <div style="border-bottom:2px solid #1E3A8A; padding-bottom:12px; margin-bottom:16px; display:flex; justify-content:space-between; align-items:center;">
              <div>
                <h2 style="color:#1E3A8A; font-size:1.25rem; font-weight:800; margin:0;">CleanDose PLC — Certificado de Lote</h2>
                <div style="font-size:0.8rem; color:#475569;">Estación Automatizada de Formulación Química a Granel</div>
              </div>
              <div style="text-align:right;">
                <span style="font-family:'JetBrains Mono',monospace; font-size:0.85rem; font-weight:700; background:#E0F2FE; color:#0284C7; padding:4px 8px; border-radius:4px;">LOTE #CD-2026-T1</span>
              </div>
            </div>

            <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:12px; background:#F8FAFC; border:1px solid #E2E8F0; border-radius:8px; padding:12px; margin-bottom:16px;">
              <div>
                <div style="font-size:0.7rem; color:#64748B; text-transform:uppercase; font-weight:700;">Fecha y Turno:</div>
                <div style="font-size:0.85rem; font-weight:700;">${dateStr} (${timeStr})</div>
              </div>
              <div>
                <div style="font-size:0.7rem; color:#64748B; text-transform:uppercase; font-weight:700;">Total Envasado:</div>
                <div style="font-size:0.85rem; font-weight:700; color:#16A34A;">${PLC.counters.C1.CV} bidones (${PLC.plant.totalLitersDispensed.toFixed(2)} Litros)</div>
              </div>
              <div>
                <div style="font-size:0.7rem; color:#64748B; text-transform:uppercase; font-weight:700;">Seguridad Poka-Yoke:</div>
                <div style="font-size:0.85rem; font-weight:700; color:#0284C7;">Activa / 100% Conformidad</div>
              </div>
            </div>

            <h4 style="font-size:0.9rem; font-weight:700; margin-bottom:8px; color:#1E3A8A;">Registro Cronológico de Eventos (Auditoría en Tiempo Real):</h4>
            <div style="max-height:220px; overflow-y:auto; border:1px solid #E2E8F0; border-radius:6px;">
              <table style="width:100%; border-collapse:collapse; font-size:0.78rem;">
                <thead>
                  <tr style="background:#F1F5F9; border-bottom:1px solid #CBD5E1; text-align:left;">
                    <th style="padding:6px 10px;">Hora</th>
                    <th style="padding:6px 10px;">Tipo</th>
                    <th style="padding:6px 10px;">Receta</th>
                    <th style="padding:6px 10px;">Descripción</th>
                  </tr>
                </thead>
                <tbody>
                  ${productionLog.length === 0 ? '<tr><td colspan="4" style="padding:10px; text-align:center; color:#94A3B8;">Sin registros de ciclo aún</td></tr>' : 
                    productionLog.map(e => `
                      <tr style="border-bottom:1px solid #F1F5F9;">
                        <td style="padding:6px 10px; font-family:'JetBrains Mono',monospace;">${e.time}</td>
                        <td style="padding:6px 10px; font-weight:700;">${e.type}</td>
                        <td style="padding:6px 10px;">${e.recipe}</td>
                        <td style="padding:6px 10px; color:#334155;">${e.desc}</td>
                      </tr>
                    `).join('')
                  }
                </tbody>
              </table>
            </div>

            <div style="margin-top:20px; padding-top:16px; border-top:1px dashed #CBD5E1; display:flex; justify-content:space-between; font-size:0.78rem; color:#64748B;">
              <div>Firma Operario de Turno: _________________________</div>
              <div>Supervisor de Calidad &amp; Validado por PLC S7-1200</div>
            </div>
          </div>
        `;

        reportBody.innerHTML = logHtml;
        auditModal.classList.add('open');
        playSound('click');
      });

      function closeModal() {
        auditModal.classList.remove('open');
      }
      if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
      if (btnCloseReport) btnCloseReport.addEventListener('click', closeModal);

      if (btnPrintReport) {
        btnPrintReport.addEventListener('click', () => {
          window.print();
        });
      }
    }
  }

  // ==========================================================================
  // 8. ARRANQUE DEL SISTEMA
  // ==========================================================================
  function init() {
    setupEventListeners();
    logEvent('SISTEMA', 'Controlador PLC inicializado en modo RUN. Ciclo Scan a 50ms.');

    // Bucle cíclico determinístico del PLC
    setInterval(plcScanCycle, PLC.scanIntervalMs);
  }

  // Ejecutar cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
