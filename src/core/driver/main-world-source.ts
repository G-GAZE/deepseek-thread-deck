import type { RemoteSource } from '@/core/sync/types';

/**
 * MAIN world 只读通道**占位，未实现**（ADR-007 补充说明）。
 *
 * TODO(ADR-007)：等人工实测 DeepSeek 页面结构后再实现。当前刻意什么都不做：
 * - 不写任何 DOM 查询 / 选择器；
 * - 不写 IndexedDB 库名与表名；
 * - 不建立 postMessage 或其它跨 world 通道。
 *
 * 约束：该通道**仅限只读**。写入类能力不得复用此通道，需另行 ADR 评审。
 *
 * 说明：目前没有任何入口引用本模块，因此**不会进入构建产物**。
 */
export function createMainWorldSource(): RemoteSource {
  throw new Error('not implemented: waiting for real page structure');
}
