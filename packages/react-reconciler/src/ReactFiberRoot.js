/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {ReactNodeList, ReactFormState} from 'shared/ReactTypes';
import type {
  FiberRoot,
  SuspenseHydrationCallbacks,
  TransitionTracingCallbacks,
} from './ReactInternalTypes';
import type {RootTag} from './ReactRootTags';
import type {Cache} from './ReactFiberCacheComponent';
import type {Container} from './ReactFiberConfig';

import {noTimeout} from './ReactFiberConfig';
import {createHostRootFiber} from './ReactFiber';
import {
  NoLane,
  NoLanes,
  NoTimestamp,
  TotalLanes,
  createLaneMap,
} from './ReactFiberLane';
import {
  enableSuspenseCallback,
  enableCache,
  enableProfilerCommitHooks,
  enableProfilerTimer,
  enableUpdaterTracking,
  enableTransitionTracing,
} from 'shared/ReactFeatureFlags';
import {initializeUpdateQueue} from './ReactFiberClassUpdateQueue';
import {LegacyRoot, ConcurrentRoot} from './ReactRootTags';
import {createCache, retainCache} from './ReactFiberCacheComponent';

export type RootState = {
  element: any,
  isDehydrated: boolean,
  cache: Cache,
};

function FiberRootNode(
  this: $FlowFixMe,
  containerInfo: any,
  // $FlowFixMe[missing-local-annot]
  tag,
  hydrate: any,
  identifierPrefix: any,
  onRecoverableError: any,
  formState: ReactFormState<any, any> | null,
) {
  this.tag = tag; // 应用模式：1 表示并发渲染模式
  this.containerInfo = containerInfo; // 存储#root dom对象
  this.pendingChildren = null;
  this.current = null; // 这个属性指向Current Fiber Tree的根节点 也就是HostFiberRoot
  this.pingCache = null;
  this.finishedWork = null; // 存储创建完成的FiberTree
  this.timeoutHandle = noTimeout;
  this.cancelPendingCommit = null;
  this.context = null;
  this.pendingContext = null;
  this.next = null;
  this.callbackNode = null; // 回调节点，存储当前任务task
  this.callbackPriority = NoLane; // 回调任务优先级
  this.expirationTimes = createLaneMap(NoTimestamp);

  this.pendingLanes = NoLanes;  // 默认 0
  this.suspendedLanes = NoLanes;
  this.pingedLanes = NoLanes;
  this.expiredLanes = NoLanes;
  this.finishedLanes = NoLanes;
  this.errorRecoveryDisabledLanes = NoLanes;
  this.shellSuspendCounter = 0;

  this.entangledLanes = NoLanes;
  this.entanglements = createLaneMap(NoLanes);

  this.hiddenUpdates = createLaneMap(null);

  this.identifierPrefix = identifierPrefix;
  this.onRecoverableError = onRecoverableError;

  if (enableCache) {
    this.pooledCache = null;
    this.pooledCacheLanes = NoLanes;
  }

  if (enableSuspenseCallback) {
    this.hydrationCallbacks = null;
  }

  this.formState = formState;

  this.incompleteTransitions = new Map();
  if (enableTransitionTracing) {
    this.transitionCallbacks = null;
    const transitionLanesMap = (this.transitionLanes = []);
    for (let i = 0; i < TotalLanes; i++) {
      transitionLanesMap.push(null);
    }
  }

  if (enableProfilerTimer && enableProfilerCommitHooks) {
    this.effectDuration = 0;
    this.passiveEffectDuration = 0;
  }

  if (enableUpdaterTracking) {
    this.memoizedUpdaters = new Set();
    const pendingUpdatersLaneMap = (this.pendingUpdatersLaneMap = []);
    for (let i = 0; i < TotalLanes; i++) {
      pendingUpdatersLaneMap.push(new Set());
    }
  }

  if (__DEV__) {
    switch (tag) {
      case ConcurrentRoot:
        this._debugRootType = hydrate ? 'hydrateRoot()' : 'createRoot()';
        break;
      case LegacyRoot:
        this._debugRootType = hydrate ? 'hydrate()' : 'render()';
        break;
    }
  }
}

// 创建root应用根节点对象
export function createFiberRoot(
  containerInfo: Container,
  tag: RootTag,
  hydrate: boolean,
  initialChildren: ReactNodeList,
  hydrationCallbacks: null | SuspenseHydrationCallbacks,
  isStrictMode: boolean,
  concurrentUpdatesByDefaultOverride: null | boolean,
  // TODO: We have several of these arguments that are conceptually part of the
  // host config, but because they are passed in at runtime, we have to thread
  // them through the root constructor. Perhaps we should put them all into a
  // single type, like a DynamicHostConfig that is defined by the renderer.
  identifierPrefix: string,
  onRecoverableError: null | ((error: mixed) => void),
  transitionCallbacks: null | TransitionTracingCallbacks,
  formState: ReactFormState<any, any> | null,
): FiberRoot {
  // $FlowFixMe[invalid-constructor] Flow no longer supports calling new on functions
  // 创建root应用根节点对象 【FiberRootNode】
  const root: FiberRoot = (new FiberRootNode(
    containerInfo,
    tag, // 1
    hydrate,
    identifierPrefix,
    onRecoverableError,
    formState,
  ): any);
  if (enableSuspenseCallback) {
    root.hydrationCallbacks = hydrationCallbacks;
  }

  if (enableTransitionTracing) {
    root.transitionCallbacks = transitionCallbacks;
  }

  // Cyclic construction. This cheats the type system right now because
  // stateNode is any.
  // 创建一个FiberNode对象【HostRootFiber】，它是Fiber树的根节点，非常重要
  const uninitializedFiber = createHostRootFiber(
    tag,
    isStrictMode,
    concurrentUpdatesByDefaultOverride,
  );

  // 【关联起来，以便在后续的渲染过程中能够正确地处理该组件树的更新和重新渲染。】
  // 将root应用根节点对象的current属性 指向了当前Current Fiber Tree组件树的根节点【HostRootFiber】
  root.current = uninitializedFiber;
  // 然后将HostFiber.stateNode属性值：设置为root应用根节点对象
  uninitializedFiber.stateNode = root;

  if (enableCache) {
    const initialCache = createCache();
    retainCache(initialCache);

    // The pooledCache is a fresh cache instance that is used temporarily
    // for newly mounted boundaries during a render. In general, the
    // pooledCache is always cleared from the root at the end of a render:
    // it is either released when render commits, or moved to an Offscreen
    // component if rendering suspends. Because the lifetime of the pooled
    // cache is distinct from the main memoizedState.cache, it must be
    // retained separately.
    root.pooledCache = initialCache;
    retainCache(initialCache);
    const initialState: RootState = {
      element: initialChildren,
      isDehydrated: hydrate,
      cache: initialCache,
    };
    uninitializedFiber.memoizedState = initialState;
  } else {
    const initialState: RootState = {
      element: initialChildren,
      isDehydrated: hydrate,
      cache: (null: any), // not enabled yet
    };
    // 初始化数据
    uninitializedFiber.memoizedState = initialState;
  }

  // 初始化HostRootFiber根节点对象的updateQueue属性
  initializeUpdateQueue(uninitializedFiber);
  // 返回root应用根节点对象【容器】
  return root;
}
