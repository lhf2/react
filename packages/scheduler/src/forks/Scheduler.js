/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable no-var */

import type {PriorityLevel} from '../SchedulerPriorities';

import {
  enableSchedulerDebugging,
  enableProfiling,
  enableIsInputPending,
  enableIsInputPendingContinuous,
  frameYieldMs,
  continuousYieldMs,
  maxYieldMs,
  userBlockingPriorityTimeout,
  lowPriorityTimeout,
  normalPriorityTimeout,
} from '../SchedulerFeatureFlags';

import {push, pop, peek} from '../SchedulerMinHeap';

// TODO: Use symbols?
import {
  ImmediatePriority,
  UserBlockingPriority,
  NormalPriority,
  LowPriority,
  IdlePriority,
} from '../SchedulerPriorities';
import {
  markTaskRun,
  markTaskYield,
  markTaskCompleted,
  markTaskCanceled,
  markTaskErrored,
  markSchedulerSuspended,
  markSchedulerUnsuspended,
  markTaskStart,
  stopLoggingProfilingEvents,
  startLoggingProfilingEvents,
} from '../SchedulerProfiling';

export type Callback = boolean => ?Callback;

export opaque type Task = {
  id: number,
  callback: Callback | null,
  priorityLevel: PriorityLevel,
  startTime: number,
  expirationTime: number,
  sortIndex: number,
  isQueued?: boolean,
};

let getCurrentTime: () => number | DOMHighResTimeStamp;
const hasPerformanceNow =
  // $FlowFixMe[method-unbinding]
  typeof performance === 'object' && typeof performance.now === 'function';

if (hasPerformanceNow) {
  const localPerformance = performance;
  getCurrentTime = () => localPerformance.now();
} else {
  const localDate = Date;
  const initialTime = localDate.now();
  getCurrentTime = () => localDate.now() - initialTime;
}

// Max 31 bit integer. The max integer size in V8 for 32-bit systems.
// Math.pow(2, 30) - 1
// 0b111111111111111111111111111111
var maxSigned31BitInt = 1073741823;

// Tasks are stored on a min heap
var taskQueue: Array<Task> = [];
var timerQueue: Array<Task> = [];

// Incrementing id counter. Used to maintain insertion order.
var taskIdCounter = 1;

// Pausing the scheduler is useful for debugging.
var isSchedulerPaused = false;

var currentTask = null;
var currentPriorityLevel = NormalPriority;

// This is set while performing work, to prevent re-entrance.
var isPerformingWork = false;

var isHostCallbackScheduled = false;
var isHostTimeoutScheduled = false;

// Capture local references to native APIs, in case a polyfill overrides them.
const localSetTimeout = typeof setTimeout === 'function' ? setTimeout : null;
const localClearTimeout =
  typeof clearTimeout === 'function' ? clearTimeout : null;
const localSetImmediate =
  typeof setImmediate !== 'undefined' ? setImmediate : null; // IE and Node.js + jsdom

const isInputPending =
  typeof navigator !== 'undefined' &&
  // $FlowFixMe[prop-missing]
  navigator.scheduling !== undefined &&
  // $FlowFixMe[incompatible-type]
  navigator.scheduling.isInputPending !== undefined
    ? navigator.scheduling.isInputPending.bind(navigator.scheduling)
    : null;

const continuousOptions = {includeContinuous: enableIsInputPendingContinuous};

function advanceTimers(currentTime: number) {
  // Check for tasks that are no longer delayed and add them to the queue.
  let timer = peek(timerQueue);
  while (timer !== null) {
    if (timer.callback === null) {
      // Timer was cancelled.
      pop(timerQueue);
    } else if (timer.startTime <= currentTime) {
      // Timer fired. Transfer to the task queue.
      pop(timerQueue);
      timer.sortIndex = timer.expirationTime;
      push(taskQueue, timer);
      if (enableProfiling) {
        markTaskStart(timer, currentTime);
        timer.isQueued = true;
      }
    } else {
      // Remaining timers are pending.
      return;
    }
    timer = peek(timerQueue);
  }
}

function handleTimeout(currentTime: number) {
  isHostTimeoutScheduled = false;
  advanceTimers(currentTime);

  if (!isHostCallbackScheduled) {
    if (peek(taskQueue) !== null) {
      isHostCallbackScheduled = true;
      requestHostCallback();
    } else {
      const firstTimer = peek(timerQueue);
      if (firstTimer !== null) {
        requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
      }
    }
  }
}

// 冲刷回调工作
function flushWork(initialTime: number) {
  if (enableProfiling) {
    markSchedulerUnsuspended(initialTime);
  }

  // We'll need a host callback the next time work is scheduled.
  // 设置 isHostCallbackScheduled 为 false，
  // 意思是：下次执行任务时，需要重新调度一个host主机回调任务。其实就是保证每次更新需要调度一个Host主机回调任务
  isHostCallbackScheduled = false;
  if (isHostTimeoutScheduled) {
    // We scheduled a timeout but it's no longer needed. Cancel it.
    isHostTimeoutScheduled = false;
    cancelHostTimeout();
  }

  // 设置执行状态为：正在执行中
  isPerformingWork = true;
  // 取出当前的task调度优先级
  const previousPriorityLevel = currentPriorityLevel;
  try {
    if (enableProfiling) {
      try {
        // 开始执行工作循环
        return workLoop(initialTime);
      } catch (error) {
        if (currentTask !== null) {
          const currentTime = getCurrentTime();
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskErrored(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        throw error;
      }
    } else {
      // No catch in prod code path.
      return workLoop(initialTime);
    }
  } finally {
    // 清除当前任务
    currentTask = null;
    currentPriorityLevel = previousPriorityLevel;
    // 设置执行状态为：停止
    isPerformingWork = false;
    if (enableProfiling) {
      const currentTime = getCurrentTime();
      markSchedulerSuspended(currentTime);
    }
  }
}

// 工作循环【可中断的循环过程】
function workLoop(initialTime: number) {
  let currentTime = initialTime;
  // 将到期的task任务，从timerQueue取出，添加到taskQueue
  advanceTimers(currentTime);
  // 从任务队列中取出队列第一个任务【注意：taskQueue中是按任务的到期时间expirationTime排序的，越小越先执行】
  currentTask = peek(taskQueue);

  // 循环从taskQueue中取出任务
  while (
    currentTask !== null &&
    !(enableSchedulerDebugging && isSchedulerPaused)
  ) {
    /**
     * 【重点判断】
     * 1，如果当前任务到期时间 大于 当前时间，说明任务还未过期
     * 2，hasTimeRemaining 为 false 即没有剩余时间了 或者 shouldYieldToHost 为 true 应该暂停
     * 总结：如果同时满足这两个条件，即任务还没过期，但是没有剩余可执行时间了，就应该跳出本次工作循环，
     * 让出主线程，交给渲染流水线，等待下一个宏任务执行task
     */
    if (currentTask.expirationTime > currentTime && shouldYieldToHost()) {
      // This currentTask hasn't expired, and we've reached the deadline.
      break;
    }
    // $FlowFixMe[incompatible-use] found when upgrading Flow
    // 说明：任务到期或者还有剩余执行时间，都可以执行任务
    // 取出当前任务的 callback 回调函数
    const callback = currentTask.callback;
    if (typeof callback === 'function') {
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      currentTask.callback = null;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      // 取出当前任务的优先级
      currentPriorityLevel = currentTask.priorityLevel;
      // $FlowFixMe[incompatible-use] found when upgrading Flow
      // 判断任务是否已经过期【已经过期的任务，需要同步执行完成，无法中断】
      const didUserCallbackTimeout = currentTask.expirationTime <= currentTime;
      if (enableProfiling) {
        // $FlowFixMe[incompatible-call] found when upgrading Flow
        markTaskRun(currentTask, currentTime);
      }
      // 调用callback()，开始执行回调 【这里的callback就是异步并发更新的执行方法】
      const continuationCallback = callback(didUserCallbackTimeout);
      currentTime = getCurrentTime();
      if (typeof continuationCallback === 'function') {
        // If a continuation is returned, immediately yield to the main thread
        // regardless of how much time is left in the current time slice.
        // $FlowFixMe[incompatible-use] found when upgrading Flow
        // 说明任务还未完成，将任务继续设置未当前任务的callback，等待下次继续执行
        // 这里没有删除这个任务，则下次取出的第一个任务，还是这个任务，
        currentTask.callback = continuationCallback;
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskYield(currentTask, currentTime);
        }
        advanceTimers(currentTime);
        return true;
      } else {
        if (enableProfiling) {
          // $FlowFixMe[incompatible-call] found when upgrading Flow
          markTaskCompleted(currentTask, currentTime);
          // $FlowFixMe[incompatible-use] found when upgrading Flow
          currentTask.isQueued = false;
        }
        // 说明任务已经执行完成
        if (currentTask === peek(taskQueue)) {
          // 从任务队列中删除已执行的任务
          pop(taskQueue);
        }
        // 继续将到期的task任务，从timerQueue取出，添加到taskQueue
        advanceTimers(currentTime);
      }
    } else {
      pop(taskQueue);
    }
    // 取出新的任务
    currentTask = peek(taskQueue);
  }
  // Return whether there's additional work
  // 结束本次工作循环时，根据当前任务判断还有没有任务还需要执行
  // 如果是通过break跳出的循环，可以在下次执行workLoop时，如果存在更高优先级的任务，则可以优先执行
  if (currentTask !== null) {
    // 还有工作，则会生成一个新的宏任务，在下次的宏任务中继续执行剩下的任务
    return true;
  } else {
    const firstTimer = peek(timerQueue);
    if (firstTimer !== null) {
      requestHostTimeout(handleTimeout, firstTimer.startTime - currentTime);
    }
    // 本次宏任务执行结束，返回false，结束workLoop
    return false;
  }
}

function unstable_runWithPriority<T>(
  priorityLevel: PriorityLevel,
  eventHandler: () => T,
): T {
  switch (priorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
    case LowPriority:
    case IdlePriority:
      break;
    default:
      priorityLevel = NormalPriority;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_next<T>(eventHandler: () => T): T {
  var priorityLevel;
  switch (currentPriorityLevel) {
    case ImmediatePriority:
    case UserBlockingPriority:
    case NormalPriority:
      // Shift down to normal priority
      priorityLevel = NormalPriority;
      break;
    default:
      // Anything lower than normal priority should remain at the current level.
      priorityLevel = currentPriorityLevel;
      break;
  }

  var previousPriorityLevel = currentPriorityLevel;
  currentPriorityLevel = priorityLevel;

  try {
    return eventHandler();
  } finally {
    currentPriorityLevel = previousPriorityLevel;
  }
}

function unstable_wrapCallback<T: (...Array<mixed>) => mixed>(callback: T): T {
  var parentPriorityLevel = currentPriorityLevel;
  // $FlowFixMe[incompatible-return]
  // $FlowFixMe[missing-this-annot]
  return function () {
    // This is a fork of runWithPriority, inlined for performance.
    var previousPriorityLevel = currentPriorityLevel;
    currentPriorityLevel = parentPriorityLevel;

    try {
      return callback.apply(this, arguments);
    } finally {
      currentPriorityLevel = previousPriorityLevel;
    }
  };
}

// 调度函数：并发模式下调度一个回调函数 【这里传入的 callback 就是 performConcurrentWorkOnRoot】
function unstable_scheduleCallback(
  priorityLevel: PriorityLevel,
  callback: Callback,
  options?: {delay: number},
): Task {
  // 获取当前程序执行时间
  var currentTime = getCurrentTime();

  // 定义开始时间
  var startTime;
  // 一般没有传递 options 参数【暂没有发现这种场景】
  if (typeof options === 'object' && options !== null) {
    var delay = options.delay;
    if (typeof delay === 'number' && delay > 0) {
      // 如果存在延期，则开始时间 = 当前时间 + 延期时间
      startTime = currentTime + delay;
    } else {
      // 否则，开始时间 = 当前时间
      startTime = currentTime;
    }
  } else {
    // 开始时间直接等于currentTime
    startTime = currentTime;
  }

  // 定义超时时间 【根据优先级，设置不同的超时时间】
  var timeout;
  switch (priorityLevel) {
    case ImmediatePriority:
      // Times out immediately
      timeout = -1;
      break;
    case UserBlockingPriority:
      // Eventually times out
      timeout = userBlockingPriorityTimeout;
      break;
    case IdlePriority:
      // Never times out
      timeout = maxSigned31BitInt;
      break;
    case LowPriority:
      // Eventually times out
      timeout = lowPriorityTimeout;
      break;
    case NormalPriority:
    default:
      // Eventually times out
      timeout = normalPriorityTimeout; // 默认5ms
      break;
  }

  // 到期时间,如果 task 已经到期/过期，则在执行的过程中不会被打断，必须同步执行完成
  // expirationTime 值越小的，优先级越高【说明到期时间比较快，需要优先执行】
  var expirationTime = startTime + timeout;

  // 创建新的任务
  var newTask: Task = {
    id: taskIdCounter++, // 任务id
    callback, // 回调任务
    priorityLevel, // 优先级 3
    startTime, // 开始时间
    expirationTime, // 到期时间
    sortIndex: -1, // 排序索引，越小的排在队列前面
  };
  if (enableProfiling) {
    newTask.isQueued = false;
  }

  // 开始时间 大于当前时间：说明是延期任务，先加入到延时队列 timerQueue
  if (startTime > currentTime) {
    // This is a delayed task.
    newTask.sortIndex = startTime;
    // 延时任务：加入延时队列
    push(timerQueue, newTask);
    if (peek(taskQueue) === null && newTask === peek(timerQueue)) {
      // All tasks are delayed, and this is the task with the earliest delay.
      if (isHostTimeoutScheduled) {
        // Cancel an existing timeout.
        cancelHostTimeout();
      } else {
        isHostTimeoutScheduled = true;
      }
      // Schedule a timeout.
      requestHostTimeout(handleTimeout, startTime - currentTime);
    }
  } else {
    // 正常的任务：直接加入到任务队列taskQueue
    // 设置任务索引为：到期时间，时间越小，则排在taskQueue前面，越先执行
    newTask.sortIndex = expirationTime;
    // 添加到taskQueue队列
    push(taskQueue, newTask);
    if (enableProfiling) {
      markTaskStart(newTask, currentTime);
      newTask.isQueued = true;
    }
    // Schedule a host callback, if needed. If we're already performing work,
    // wait until the next time we yield.
    // 判断host主机回调任务是否已经被调度，以及是否正在工作中
    // 如果host主机回调任务还没有被调度 且 当前并未在工作中；则需要开启一个host主机回调任务
    // 【首次加载时，需要调度一个主机回调任务】
    if (!isHostCallbackScheduled && !isPerformingWork) {
      isHostCallbackScheduled = true;
      // 设置host主机回调任务，触发 MessageChannel 生成新的宏任务，在宏任务中执行工作循环workLoop
      requestHostCallback();
    }
  }

  // 返回新的任务
  return newTask;
}

function unstable_pauseExecution() {
  isSchedulerPaused = true;
}

function unstable_continueExecution() {
  isSchedulerPaused = false;
  if (!isHostCallbackScheduled && !isPerformingWork) {
    isHostCallbackScheduled = true;
    requestHostCallback();
  }
}

function unstable_getFirstCallbackNode(): Task | null {
  return peek(taskQueue);
}

function unstable_cancelCallback(task: Task) {
  if (enableProfiling) {
    if (task.isQueued) {
      const currentTime = getCurrentTime();
      markTaskCanceled(task, currentTime);
      task.isQueued = false;
    }
  }

  // Null out the callback to indicate the task has been canceled. (Can't
  // remove from the queue because you can't remove arbitrary nodes from an
  // array based heap, only the first one.)
  task.callback = null;
}

function unstable_getCurrentPriorityLevel(): PriorityLevel {
  return currentPriorityLevel;
}

let isMessageLoopRunning = false;
let taskTimeoutID: TimeoutID = (-1: any);

// Scheduler periodically yields in case there is other work on the main
// thread, like user events. By default, it yields multiple times per frame.
// It does not attempt to align with frame boundaries, since most tasks don't
// need to be frame aligned; for those that do, use requestAnimationFrame.
let frameInterval = frameYieldMs;
const continuousInputInterval = continuousYieldMs;
const maxInterval = maxYieldMs;
let startTime = -1;

let needsPaint = false;

function shouldYieldToHost(): boolean {
  // 当前程序运行时间
  const timeElapsed = getCurrentTime() - startTime;
  // 如果运行时间小于帧间隔时间5ms
  if (timeElapsed < frameInterval) {
    // The main thread has only been blocked for a really short amount of time;
    // smaller than a single frame. Don't yield yet.
    // 主线程只被阻塞了很短的时间；小于单个帧，则可以继续执行任务
    return false;
  }

  // The main thread has been blocked for a non-negligible amount of time. We
  // may want to yield control of the main thread, so the browser can perform
  // high priority tasks. The main ones are painting and user input. If there's
  // a pending paint or a pending input, then we should yield. But if there's
  // neither, then we can yield less often while remaining responsive. We'll
  // eventually yield regardless, since there could be a pending paint that
  // wasn't accompanied by a call to `requestPaint`, or other main thread tasks
  // like network events.
  if (enableIsInputPending) {
    if (needsPaint) {
      // There's a pending paint (signaled by `requestPaint`). Yield now.
      return true;
    }
    if (timeElapsed < continuousInputInterval) {
      // We haven't blocked the thread for that long. Only yield if there's a
      // pending discrete input (e.g. click). It's OK if there's pending
      // continuous input (e.g. mouseover).
      if (isInputPending !== null) {
        return isInputPending();
      }
    } else if (timeElapsed < maxInterval) {
      // Yield if there's either a pending discrete or continuous input.
      if (isInputPending !== null) {
        return isInputPending(continuousOptions);
      }
    } else {
      // We've blocked the thread for a long time. Even if there's no pending
      // input, there may be some other scheduled work that we don't know about,
      // like a network event. Yield now.
      return true;
    }
  }

  // `isInputPending` isn't available. Yield now.
  // 如果执行已经大于5ms，结束执行，让出主线程
  return true;
}

function requestPaint() {
  if (
    enableIsInputPending &&
    navigator !== undefined &&
    // $FlowFixMe[prop-missing]
    navigator.scheduling !== undefined &&
    // $FlowFixMe[incompatible-type]
    navigator.scheduling.isInputPending !== undefined
  ) {
    needsPaint = true;
  }

  // Since we yield every frame regardless, `requestPaint` has no effect.
}

function forceFrameRate(fps: number) {
  if (fps < 0 || fps > 125) {
    // Using console['error'] to evade Babel and ESLint
    console['error'](
      'forceFrameRate takes a positive int between 0 and 125, ' +
        'forcing frame rates higher than 125 fps is not supported',
    );
    return;
  }
  if (fps > 0) {
    frameInterval = Math.floor(1000 / fps);
  } else {
    // reset the framerate
    frameInterval = frameYieldMs;
  }
}

// 执行工作直到最后时间【在有效时间内执行工作】
const performWorkUntilDeadline = () => {
  if (isMessageLoopRunning) {
    const currentTime = getCurrentTime();
    // Keep track of the start time so we can measure how long the main thread
    // has been blocked.
    startTime = currentTime;

    // If a scheduler task throws, exit the current browser task so the
    // error can be observed.
    //
    // Intentionally not using a try-catch, since that makes some debugging
    // techniques harder. Instead, if `flushWork` errors, then `hasMoreWork` will
    // remain true, and we'll continue the work loop.
    let hasMoreWork = true;
    try {
      // 执行回调任务flushWork()，根据返回判断是否还有工作
      // 这里调用结束会返回布尔值表示是否还有工作
      hasMoreWork = flushWork(currentTime);
    } finally {
      if (hasMoreWork) {
        // If there's more work, schedule the next message event at the end
        // of the preceding one.
        // 如果还有任务,则又触发 MessageChannel 事件，生成新的宏任务，即在下一个消息事件继续执行任务
        schedulePerformWorkUntilDeadline();
      } else {
        // 没有工作则设置工作循环状态为 false,停止状态
        isMessageLoopRunning = false;
      }
    }
  }
  // Yielding to the browser will give it a chance to paint, so we can
  // reset this.
  needsPaint = false;
};


// 根据环境设置调度函数, 生成宏任务
let schedulePerformWorkUntilDeadline;
if (typeof localSetImmediate === 'function') {
  // Node.js and old IE.
  // There's a few reasons for why we prefer setImmediate.
  //
  // Unlike MessageChannel, it doesn't prevent a Node.js process from exiting.
  // (Even though this is a DOM fork of the Scheduler, you could get here
  // with a mix of Node.js 15+, which has a MessageChannel, and jsdom.)
  // https://github.com/facebook/react/issues/20756
  //
  // But also, it runs earlier which is the semantic we want.
  // If other browsers ever implement it, it's better to use it.
  // Although both of these would be inferior to native scheduling.
  // Node.js and old IE. 使用setImmediate
  schedulePerformWorkUntilDeadline = () => {
    localSetImmediate(performWorkUntilDeadline);
  };
} else if (typeof MessageChannel !== 'undefined') {
  // DOM and Worker environments.
  // We prefer MessageChannel because of the 4ms setTimeout clamping.
  // 浏览器 dom 环境
  const channel = new MessageChannel(); // 宏任务
  const port = channel.port2;
  // port1的消息回调事件
  channel.port1.onmessage = performWorkUntilDeadline;
  // port2触发消息事件
  schedulePerformWorkUntilDeadline = () => {
    port.postMessage(null);
  };
} else {
  // 其他环境 使用setTimeout
  // We should only fallback here in non-browser environments.
  schedulePerformWorkUntilDeadline = () => {
    // $FlowFixMe[not-a-function] nullable value
    localSetTimeout(performWorkUntilDeadline, 0);
  };
}

function requestHostCallback() {
  // 判断消息循环是否在运行中，如果没有则开启运行
  if (!isMessageLoopRunning) {
    isMessageLoopRunning = true;
    // 调度异步执行，创建新的宏任务
    schedulePerformWorkUntilDeadline();
  }
}

function requestHostTimeout(
  callback: (currentTime: number) => void,
  ms: number,
) {
  // $FlowFixMe[not-a-function] nullable value
  taskTimeoutID = localSetTimeout(() => {
    callback(getCurrentTime());
  }, ms);
}

function cancelHostTimeout() {
  // $FlowFixMe[not-a-function] nullable value
  localClearTimeout(taskTimeoutID);
  taskTimeoutID = ((-1: any): TimeoutID);
}

export {
  ImmediatePriority as unstable_ImmediatePriority,
  UserBlockingPriority as unstable_UserBlockingPriority,
  NormalPriority as unstable_NormalPriority,
  IdlePriority as unstable_IdlePriority,
  LowPriority as unstable_LowPriority,
  unstable_runWithPriority,
  unstable_next,
  unstable_scheduleCallback,
  unstable_cancelCallback,
  unstable_wrapCallback,
  unstable_getCurrentPriorityLevel,
  shouldYieldToHost as unstable_shouldYield,
  requestPaint as unstable_requestPaint,
  unstable_continueExecution,
  unstable_pauseExecution,
  unstable_getFirstCallbackNode,
  getCurrentTime as unstable_now,
  forceFrameRate as unstable_forceFrameRate,
};

export const unstable_Profiling: {
  startLoggingProfilingEvents(): void,
  stopLoggingProfilingEvents(): ArrayBuffer | null,
} | null = enableProfiling
  ? {
      startLoggingProfilingEvents,
      stopLoggingProfilingEvents,
    }
  : null;
