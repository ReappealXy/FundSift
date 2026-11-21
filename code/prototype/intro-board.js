(function () {
  'use strict';

  const intro = document.getElementById('intro-screen');
  const board = document.getElementById('board');
  if (!intro || !board) return;

  const stage = board.closest('.stage');
  const flow = document.getElementById('flow');
  const play = document.getElementById('play');
  const position = document.getElementById('pos');
  const progress = document.getElementById('pos-bar');
  const sourceIndex = document.getElementById('src-idx');
  const sourceFile = document.getElementById('src-file');
  const sourcePosition = document.getElementById('src-pos');
  const sourceAmount = document.getElementById('src-amt');
  const sourceNote = document.getElementById('src-note');
  const sourcePin = document.getElementById('src-pin');
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

  // The startup preview uses fictional transactions and never reads case data.
  const transactions = [
    ["07-03 09:12","支付宝","张*杰","转账",5000.00,0,"支付宝账户明细_20260701-20260930.csv",412,"3"],
    ["07-03 14:38","微信","李*","群收款",128.00,0,"微信支付账单_202607_27列.txt",96,"5"],
    ["07-05 10:02","建行","王*峰","跨行转入",24600.00,0,"建行个人账户明细_202607_32列.xlsx",78,"6"],
    ["07-06 21:14","支付宝","滴滴**","打车",-32.50,0,"支付宝账户明细_20260701-20260930.csv",583,"3"],
    ["07-08 16:45","支付宝","杭州**科技","消费",-1280.00,0,"支付宝账户明细_20260701-20260930.csv",914,"3"],
    ["07-09 11:07","支付宝","天猫**专营店","消费退货",-3280.00,1,"支付宝账户明细_20260701-20260930.csv",1287,"3"],
    ["07-09 11:41","支付宝","天猫**专营店","消费退货",-2280.00,1,"支付宝账户明细_20260701-20260930.csv",1288,"3"],
    ["07-10 09:33","微信","陈*","转账",800.00,0,"微信支付账单_202607_27列.txt",154,"5"],
    ["07-11 08:55","建行","刘*","消费",-420.00,0,"建行个人账户明细_202607_32列.xlsx",203,"6"],
    ["07-11 19:20","支付宝","美团**","外卖",-58.00,0,"支付宝账户明细_20260701-20260930.csv",1502,"3"],
    ["07-12 13:06","微信","王*","红包",200.00,0,"微信支付账单_202607_27列.txt",287,"5"],
    ["07-13 10:18","建行","李*","ATM 取现",-2000.00,1,"建行个人账户明细_202607_32列.xlsx",331,"6"],
    ["07-14 15:52","支付宝","郑州**商贸","货款",-6800.00,1,"支付宝账户明细_20260701-20260930.csv",1743,"3"],
    ["07-15 09:04","微信","赵*","转账",1500.00,0,"微信支付账单_202607_27列.txt",402,"5"],
    ["07-16 17:33","建行","孙*","转账",9800.00,0,"建行个人账户明细_202607_32列.xlsx",466,"6"],
    ["07-17 11:26","支付宝","淘宝**","消费",-366.00,0,"支付宝账户明细_20260701-20260930.csv",2044,"3"],
    ["07-18 20:09","微信","周*","群收款",60.00,0,"微信支付账单_202607_27列.txt",551,"5"],
    ["07-19 08:47","支付宝","余额宝","转入",-20000.00,1,"支付宝账户明细_20260701-20260930.csv",2318,"3"],
    ["07-20 14:11","建行","吴*","跨行转出",-12600.00,1,"建行个人账户明细_202607_32列.xlsx",603,"6"],
    ["07-21 10:39","支付宝","话费充值","缴费",-100.00,0,"支付宝账户明细_20260701-20260930.csv",2607,"3"],
    ["07-22 19:55","微信","郑*","转账",2600.00,0,"微信支付账单_202607_27列.txt",690,"5"],
    ["07-23 09:21","建行","冯*","转入",3400.00,0,"建行个人账户明细_202607_32列.xlsx",712,"6"],
    ["07-24 16:08","支付宝","拼多多**","消费",-97.90,0,"支付宝账户明细_20260701-20260930.csv",2884,"3"],
    ["07-25 11:44","微信","何*","转账",450.00,0,"微信支付账单_202607_27列.txt",803,"5"]
  ];

  const reviewNotes = {
    '消费退货': '负数消费退货，待确认金额与方向',
    'ATM 取现': '大额取现，待核实现金去向',
    '货款': '对方为对公账户，待核对合同编号',
    '转入': '余额宝内部划转，待确认是否计入收入',
    '跨行转出': '大额转出，待核对手方账户'
  };
  const rowHeight = 36;
  const displayTime = 1500;
  const scrollTime = 560;
  const dragThreshold = 5;
  const idleRotation = { x: 5, y: -9 };
  const amountFormatter = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function money(amount) {
    return (amount < 0 ? '−' : '+') + amountFormatter.format(Math.abs(amount));
  }

  function displayIndex(index) {
    return String(index + 1).padStart(2, '0');
  }

  const track = document.createElement('div');
  track.className = 'track';
  flow.append(track);

  function addRow(transaction, index, repeated = false) {
    const [time, source, party, description, amount, needsReview] = transaction;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.state = needsReview ? 'warn' : 'ok';
    row.dataset.i = index;
    if (repeated) row.setAttribute('aria-hidden', 'true');
    const cells = [
      ['idx', displayIndex(index)], ['time', time], ['src', source], ['who', party],
      ['sum', description], ['amt', money(amount)], ['st', needsReview ? '待核' : '']
    ];
    for (const [className, value] of cells) {
      const cell = document.createElement('span');
      cell.className = className;
      cell.textContent = value;
      if (className === 'who') {
        const suffix = document.createElement('i');
        suffix.textContent = '尾号 ' + (1000 + (index * 137 + 861) % 9000);
        cell.append(suffix);
      }
      row.append(cell);
    }
    track.append(row);
    return row;
  }

  const rows = transactions.map((transaction, index) => addRow(transaction, index));
  // Repeat the first visible rows after the last transaction for a seamless loop.
  transactions.slice(0, 10).forEach((transaction, index) => addRow(transaction, index, true));
  document.getElementById('total').textContent = transactions.length;

  let currentIndex = -1;
  function showTransaction(index) {
    rows[currentIndex]?.removeAttribute('data-active');
    currentIndex = index;
    rows[index].dataset.active = 'true';
    const [, , , description, amount, needsReview, filename, line, column] = transactions[index];
    sourceIndex.textContent = '第 ' + displayIndex(index) + ' 笔';
    sourceFile.textContent = filename;
    sourceFile.title = filename;
    sourcePosition.textContent = line.toLocaleString('en-US') + ' 行 · 第 ' + column + ' 列';
    sourceAmount.textContent = money(amount);
    sourceNote.textContent = needsReview ? reviewNotes[description] || '待核' : '已确认，无需处理';
    sourceNote.className = needsReview ? 'flag' : 'ok';
    sourcePin.textContent = needsReview ? '原地回查' : '原件可查';
    position.textContent = displayIndex(index);
    progress.style.width = ((index + 1) / transactions.length * 100).toFixed(1) + '%';
  }

  function positionTrack(offset) {
    track.style.transform = 'translate3d(0,' + (-offset).toFixed(2) + 'px,0)';
  }

  let advanceTimer;
  let scrollFrame;
  let pauseTimer;
  let selectionHeld = false;
  let drag;

  function canAnimate() {
    return motion?.matches === false && !intro.hidden && !intro.inert && !document.hidden;
  }

  function schedulePlayback() {
    clearTimeout(advanceTimer);
    if (scrollFrame !== undefined) {
      cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
      positionTrack(currentIndex * rowHeight);
    }
    const playing = canAnimate() && document.activeElement !== flow && !selectionHeld && !drag?.started;
    play.lastElementChild.textContent = playing ? '自动播放' : '已暂停';
    play.style.borderColor = playing ? '' : 'rgba(168,67,47,.35)';
    play.style.color = playing ? '' : 'var(--seal)';
    if (playing) advanceTimer = setTimeout(scrollToNext, displayTime);
  }

  function scrollToNext() {
    if (!canAnimate()) return;
    const previousIndex = currentIndex;
    const nextIndex = (previousIndex + 1) % transactions.length;
    const startedAt = performance.now();
    function frame(now) {
      const completion = Math.max(0, Math.min(1, (now - startedAt) / scrollTime));
      const eased = completion < 0.5 ? 4 * completion ** 3 : 1 - (-2 * completion + 2) ** 3 / 2;
      positionTrack((previousIndex + eased) * rowHeight);
      if (completion < 1) {
        scrollFrame = requestAnimationFrame(frame);
        return;
      }
      scrollFrame = undefined;
      if (nextIndex === 0) positionTrack(0);
      showTransaction(nextIndex);
      schedulePlayback();
    }
    scrollFrame = requestAnimationFrame(frame);
  }

  function selectTransaction(index, holdTime) {
    selectionHeld = true;
    clearTimeout(pauseTimer);
    showTransaction(index);
    positionTrack(index * rowHeight);
    schedulePlayback();
    pauseTimer = setTimeout(() => {
      selectionHeld = false;
      schedulePlayback();
    }, holdTime);
  }

  showTransaction(0);
  positionTrack(0);

  track.addEventListener('click', event => {
    const row = event.target.closest('.row');
    if (row) selectTransaction(Number(row.dataset.i), 5000);
  });
  flow.addEventListener('focus', schedulePlayback);
  flow.addEventListener('blur', schedulePlayback);
  flow.addEventListener('keydown', event => {
    let index;
    switch (event.key) {
      case 'ArrowDown': index = Math.min(transactions.length - 1, currentIndex + 1); break;
      case 'ArrowUp': index = Math.max(0, currentIndex - 1); break;
      case 'Home': index = 0; break;
      case 'End': index = transactions.length - 1; break;
      default: return;
    }
    event.preventDefault();
    selectTransaction(index, 4000);
  });

  let rotationFrame;
  let parallaxFrame;
  let settleTimer;
  const rotation = { ...idleRotation };
  const targetRotation = { ...idleRotation };
  const parallax = { x: 0, y: 0 };
  const targetParallax = { ...parallax };

  function paintRotation() {
    board.style.setProperty('--rx', rotation.x.toFixed(2) + 'deg');
    board.style.setProperty('--ry', rotation.y.toFixed(2) + 'deg');
    board.style.setProperty('--gx', Math.max(-1, Math.min(1, rotation.y / -20)).toFixed(3));
  }

  function paintParallax() {
    intro.style.setProperty('--mx', parallax.x.toFixed(3));
    intro.style.setProperty('--my', parallax.y.toFixed(3));
  }

  function approach(current, target, rate) {
    current.x += (target.x - current.x) * rate;
    current.y += (target.y - current.y) * rate;
    return Math.abs(target.x - current.x) > 0.02 || Math.abs(target.y - current.y) > 0.02;
  }

  function moveBoard() {
    const moving = approach(rotation, targetRotation, 0.12);
    if (!moving) Object.assign(rotation, targetRotation);
    paintRotation();
    rotationFrame = moving ? requestAnimationFrame(moveBoard) : undefined;
  }

  function moveParallax() {
    const moving = approach(parallax, targetParallax, 0.1);
    if (!moving) Object.assign(parallax, targetParallax);
    paintParallax();
    parallaxFrame = moving ? requestAnimationFrame(moveParallax) : undefined;
  }

  function scheduleRotation() {
    if (rotationFrame === undefined) rotationFrame = requestAnimationFrame(moveBoard);
  }

  intro.addEventListener('mousemove', event => {
    if (!canAnimate()) return;
    targetParallax.x = (event.clientX / window.innerWidth - 0.5) * 2;
    targetParallax.y = (event.clientY / window.innerHeight - 0.5) * 2;
    if (parallaxFrame === undefined) parallaxFrame = requestAnimationFrame(moveParallax);
  }, { passive: true });

  stage.addEventListener('mousemove', event => {
    if (!canAnimate() || drag) return;
    const bounds = board.getBoundingClientRect();
    targetRotation.x = idleRotation.x - ((event.clientY - bounds.top) / bounds.height - 0.5) * 8;
    targetRotation.y = idleRotation.y + ((event.clientX - bounds.left) / bounds.width - 0.5) * 12;
    scheduleRotation();
  });
  stage.addEventListener('mouseleave', () => {
    if (!canAnimate() || drag) return;
    Object.assign(targetRotation, idleRotation);
    scheduleRotation();
  });

  board.addEventListener('pointerdown', event => {
    if (!canAnimate() || drag || event.button !== 0) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      rotation: { ...rotation },
      started: false
    };
  });

  window.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.started) {
      if (Math.hypot(dx, dy) < dragThreshold) return;
      drag.started = true;
      // A stationary pointer remains on its row so that a normal click reaches it.
      board.setPointerCapture(event.pointerId);
      board.classList.add('dragging');
      if (rotationFrame !== undefined) cancelAnimationFrame(rotationFrame);
      rotationFrame = undefined;
      schedulePlayback();
    }
    targetRotation.x = rotation.x = Math.max(-16, Math.min(20, drag.rotation.x - dy * 0.13));
    targetRotation.y = rotation.y = Math.max(-26, Math.min(26, drag.rotation.y + dx * 0.15));
    paintRotation();
  });

  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    const wasDragging = drag.started;
    drag = undefined;
    if (!wasDragging) return;
    board.classList.remove('dragging');
    board.classList.add('settling');
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => board.classList.remove('settling'), 680);
    Object.assign(targetRotation, idleRotation);
    scheduleRotation();
    schedulePlayback();
  }
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', finishDrag);
  board.addEventListener('lostpointercapture', finishDrag);

  function syncVisibility() {
    if (!canAnimate()) {
      if (rotationFrame !== undefined) cancelAnimationFrame(rotationFrame);
      if (parallaxFrame !== undefined) cancelAnimationFrame(parallaxFrame);
      rotationFrame = undefined;
      parallaxFrame = undefined;
      drag = undefined;
      clearTimeout(settleTimer);
      board.classList.remove('dragging', 'settling');
      Object.assign(rotation, idleRotation);
      Object.assign(targetRotation, idleRotation);
      parallax.x = targetParallax.x = 0;
      parallax.y = targetParallax.y = 0;
      paintRotation();
      paintParallax();
    }
    schedulePlayback();
  }

  new MutationObserver(syncVisibility).observe(intro, {
    attributes: true,
    attributeFilter: ['hidden', 'inert']
  });
  document.addEventListener('visibilitychange', syncVisibility);
  motion?.addEventListener?.('change', syncVisibility);
  syncVisibility();
}());
