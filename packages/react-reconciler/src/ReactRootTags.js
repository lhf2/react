/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type RootTag = 0 | 1;

// 历史遗留模式，针对16，17版本
export const LegacyRoot = 0;
// 并发模式【react18默认开启】
export const ConcurrentRoot = 1;
