/**
 * 页面 DOM 选择器唯一出口（ADR-008）。
 *
 * 当前是骨架：P0 尚未实测 DeepSeek 页面结构，**所有选择器保持 null**。
 * 真实选择器必须由人工在真实页面上实测后填入，禁止凭猜测写入 —— 猜错会让
 * 故障从「适配中」退化成「静默读错数据」。
 *
 * 失效处理（AGENTS.md §7）：选择器不可用时 UI 显示「适配中」，只读功能不阻塞。
 */

export type SelectorStatus =
  /** 尚未实测填入 */
  | 'unverified'
  /** 已在真实页面验证可用 */
  | 'verified'
  /** 曾经可用，当前页面改版导致失效 */
  | 'broken';

export interface SelectorDefinition {
  /** CSS 选择器；null 表示尚未适配，调用方必须走降级路径。 */
  readonly selector: string | null;
  readonly status: SelectorStatus;
  /** 实测记录：验证日期、页面版本、注意事项。 */
  readonly note?: string;
}

export const SELECTOR_NAMES = [
  'conversationList',
  'conversationItem',
  'messageList',
  'messageItem',
  'sidebarAnchor',
] as const;

export type SelectorName = (typeof SELECTOR_NAMES)[number];

export type SelectorTable = Readonly<Record<SelectorName, SelectorDefinition>>;

const PENDING_NOTE = '待实测填入：不得凭猜测写入真实选择器';

export const SELECTORS: SelectorTable = {
  conversationList: { selector: null, status: 'unverified', note: PENDING_NOTE },
  conversationItem: { selector: null, status: 'unverified', note: PENDING_NOTE },
  messageList: { selector: null, status: 'unverified', note: PENDING_NOTE },
  messageItem: { selector: null, status: 'unverified', note: PENDING_NOTE },
  sidebarAnchor: { selector: null, status: 'unverified', note: PENDING_NOTE },
};

/** 只有「已实测且状态正常」才算可用于生产读取。 */
export function isSelectorAdapted(name: SelectorName): boolean {
  return isAdaptedDefinition(SELECTORS[name]);
}

/** 纯判定，便于对「状态已标 verified 但选择器仍为空」这种错配单独测试。 */
export function isAdaptedDefinition(definition: SelectorDefinition): boolean {
  return definition.status === 'verified' && definition.selector !== null;
}

/** 尚未适配的选择器清单，用于「适配中」提示与同步前置检查。 */
export function missingSelectors(): SelectorName[] {
  return SELECTOR_NAMES.filter((name) => !isSelectorAdapted(name));
}

export function allSelectorsAdapted(): boolean {
  return missingSelectors().length === 0;
}

/** 面向用户的状态文案：未适配与失效都提示「适配中」，避免暴露内部术语。 */
export function selectorStatusLabel(status: SelectorStatus): string {
  return status === 'verified' ? '已适配' : '适配中';
}
