/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 */

export type PriorityLevel = 0 | 1 | 2 | 3 | 4 | 5;

// TODO: Use symbols?
export const NoPriority = 0;
// scheduler的调度优先级 值越小优先级越高
export const ImmediatePriority = 1; // 最高优先级，同步执行
export const UserBlockingPriority = 2;
export const NormalPriority = 3; // 默认优先级
export const LowPriority = 4;
export const IdlePriority = 5; // 最低优先级
