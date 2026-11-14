// 单元测试公共初始化。
// IndexedDB 在 Node 环境不存在，用 fake-indexeddb 提供实现，保证 Dexie 可跑。
import 'fake-indexeddb/auto';
