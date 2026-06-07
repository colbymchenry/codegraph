/**
 * 国际化 (i18n) 模块 — 双语支持 (中文/English)
 *
 * 自动检测 VS Code 显示语言，选择对应的文案。
 * - vscode.env.language 返回 'zh-cn', 'zh-tw', 'en', 'ja' 等
 * - 所有 'zh-*' 开头的语言使用中文文案
 * - 其他语言默认使用英文文案
 *
 * 使用方式：
 * import { t } from './i18n';
 * vscode.window.showInformationMessage(t('extension.activated'));
 */

import * as vscode from 'vscode';

// =============================================================================
// 语言检测
// =============================================================================

/**
 * 检测当前 VS Code 是否使用中文界面。
 * VS Code 的 env.language 返回 BCP 47 语言标签，如 'zh-cn', 'zh-tw', 'en', 'ja'。
 * 所有以 'zh' 开头的标签都视为中文用户。
 */
function isChinese(): boolean {
  const lang = vscode.env.language || 'en';
  return lang.toLowerCase().startsWith('zh');
}

// =============================================================================
// 双语消息字典
// =============================================================================

/**
 * 所有界面文案定义 — 每条消息包含 en (英文) 和 zh (中文) 两个版本。
 * key 采用 模块.功能.描述 的命名规范。
 */
const messages = {
  // ---- 扩展状态 ----
  'status.notInitialized': {
    en: 'CodeGraph not initialized',
    zh: 'CodeGraph 未初始化',
  },
  'status.indexing': {
    en: 'CodeGraph indexing...',
    zh: 'CodeGraph 正在索引...',
  },
  'status.ready': {
    en: 'CodeGraph ready',
    zh: 'CodeGraph 已就绪',
  },
  'status.error': {
    en: 'CodeGraph error',
    zh: 'CodeGraph 错误',
  },

  // ---- 侧边栏 ----
  'sidebar.title': {
    en: 'CodeGraph Explorer',
    zh: 'CodeGraph 浏览器',
  },
  'sidebar.notInitialized': {
    en: 'Project not indexed. Click "Build Index" above to start.',
    zh: '项目未建立 CodeGraph 索引，点击上方「建立索引」按钮开始',
  },
  'sidebar.indexing': {
    en: 'Building knowledge graph, please wait...',
    zh: '正在构建知识图谱，请稍候...',
  },
  'sidebar.error': {
    en: 'Failed to connect to CodeGraph. Click to retry.',
    zh: '连接 CodeGraph 失败，点击重试',
  },
  'sidebar.files': {
    en: 'Files',
    zh: '文件',
  },
  'sidebar.symbols': {
    en: 'Symbols',
    zh: '符号',
  },
  'sidebar.searchResults': {
    en: 'Search Results',
    zh: '搜索结果',
  },
  'sidebar.browseFiles': {
    en: 'Browse project file structure',
    zh: '浏览项目文件结构',
  },
  'sidebar.browseSymbols': {
    en: 'Browse symbols by type',
    zh: '按类型浏览符号',
  },
  'sidebar.recentSearches': {
    en: 'Recent symbol searches',
    zh: '最近的符号搜索',
  },

  // ---- 侧边栏 TreeView 错误节点 ----
  'tree.noFiles': {
    en: 'No files found',
    zh: '未找到文件',
  },
  'tree.noIndexedFiles': {
    en: 'No indexed files',
    zh: '无已索引的文件',
  },
  'tree.loadFilesFailed': {
    en: 'Failed to load files: {0}',
    zh: '加载文件失败: {0}',
  },
  'tree.noSymbols': {
    en: 'No symbols found',
    zh: '未找到符号',
  },
  'tree.noIndexedSymbols': {
    en: 'No symbols indexed',
    zh: '无已索引的符号',
  },
  'tree.loadSymbolsFailed': {
    en: 'Failed to load symbols: {0}',
    zh: '加载符号失败: {0}',
  },

  // ---- 操作按钮 ----
  'action.buildIndex': {
    en: 'Build Index',
    zh: '建立索引',
  },
  'action.deleteIndex': {
    en: 'Delete Index',
    zh: '删除索引',
  },
  'action.buildIndexTooltip': {
    en: 'Build CodeGraph index for current project',
    zh: '为当前项目建立 CodeGraph 索引',
  },
  'action.deleteIndexTooltip': {
    en: 'Delete CodeGraph index for current project',
    zh: '删除当前项目的 CodeGraph 索引',
  },
  'action.retry': {
    en: 'Retry Connection',
    zh: '重试连接',
  },
  'action.initialize': {
    en: 'Initialize CodeGraph',
    zh: '初始化 CodeGraph',
  },
  'action.reindex': {
    en: 'Re-index',
    zh: '重新索引',
  },
  'action.search': {
    en: 'Search Symbol',
    zh: '搜索符号',
  },

  // ---- 提示信息 ----
  'prompt.alreadyInitialized': {
    en: 'CodeGraph is already initialized and ready.',
    zh: 'CodeGraph 已初始化并就绪。',
  },
  'prompt.notReady': {
    en: 'CodeGraph is not ready yet.',
    zh: 'CodeGraph 尚未就绪。',
  },
  'prompt.noWorkspace': {
    en: 'No workspace folder is open.',
    zh: '未打开工作区文件夹。',
  },
  'prompt.noSymbol': {
    en: 'No symbol found at cursor position.',
    zh: '光标位置未找到符号。',
  },
  'prompt.noResults': {
    en: 'No results found.',
    zh: '未找到结果。',
  },
  'prompt.noResultsFor': {
    en: 'No results found for "{0}".',
    zh: '未找到 "{0}" 的结果。',
  },
  'prompt.symbolNotFound': {
    en: 'Symbol "{0}" not found in the codebase.',
    zh: '代码库中未找到符号 "{0}"。',
  },
  'prompt.noCallers': {
    en: 'No callers found for "{0}".',
    zh: '未找到 "{0}" 的调用者。',
  },
  'prompt.noCallees': {
    en: 'No callees found for "{0}".',
    zh: '未找到 "{0}" 的被调用者。',
  },
  'prompt.noImpact': {
    en: 'No impact analysis found for "{0}".',
    zh: '未找到 "{0}" 的影响分析。',
  },
  'prompt.cannotOpenFile': {
    en: 'Could not open {0}: {1}',
    zh: '无法打开 {0}: {1}',
  },
  'prompt.initQuestion': {
    en: 'This project is not indexed by CodeGraph. Would you like to build the index now?',
    zh: '项目未建立 CodeGraph 索引。是否立即建立索引？',
  },

  // ---- 确认对话框 ----
  'confirm.deleteIndex': {
    en: 'Are you sure you want to delete the CodeGraph index for this project? This action cannot be undone.',
    zh: '确定要删除当前项目的 CodeGraph 索引吗？此操作不可撤销。',
  },
  'confirm.deleteIndexTitle': {
    en: 'Delete Index',
    zh: '删除索引',
  },
  'confirm.yes': {
    en: 'Yes',
    zh: '是',
  },
  'confirm.no': {
    en: 'No',
    zh: '否',
  },
  'confirm.cancel': {
    en: 'Cancel',
    zh: '取消',
  },
  'confirm.later': {
    en: 'Later',
    zh: '稍后',
  },

  // ---- 安装相关 ----
  'install.notFound': {
    en: 'CodeGraph not detected, auto-installing...',
    zh: '未检测到 CodeGraph，正在自动安装...',
  },
  'install.installing': {
    en: 'Installing CodeGraph...',
    zh: '正在安装 CodeGraph...',
  },
  'install.success': {
    en: 'CodeGraph installed successfully!',
    zh: 'CodeGraph 安装成功！',
  },
  'install.failed': {
    en: 'CodeGraph installation failed: {0}',
    zh: 'CodeGraph 安装失败: {0}',
  },
  'install.failedHint': {
    en: 'Auto-install failed. Please install manually:\n{0}',
    zh: '自动安装失败。请手动安装:\n{0}',
  },
  'install.checking': {
    en: 'Checking CodeGraph installation status...',
    zh: '正在检查 CodeGraph 安装状态...',
  },

  // ---- 索引相关 ----
  'index.building': {
    en: 'Building CodeGraph index...',
    zh: '正在建立 CodeGraph 索引...',
  },
  'index.buildSuccess': {
    en: 'CodeGraph index built successfully!',
    zh: 'CodeGraph 索引建立成功！',
  },
  'index.buildFailed': {
    en: 'CodeGraph index build failed: {0}',
    zh: 'CodeGraph 索引建立失败: {0}',
  },
  'index.deleting': {
    en: 'Deleting CodeGraph index...',
    zh: '正在删除 CodeGraph 索引...',
  },
  'index.deleteSuccess': {
    en: 'CodeGraph index deleted.',
    zh: 'CodeGraph 索引已删除。',
  },
  'index.deleteFailed': {
    en: 'CodeGraph index deletion failed: {0}',
    zh: 'CodeGraph 索引删除失败: {0}',
  },
  'index.reindexing': {
    en: 'Re-indexing...',
    zh: '正在重新索引...',
  },
  'index.reindexSuccess': {
    en: 'CodeGraph re-index completed.',
    zh: 'CodeGraph 重新索引完成。',
  },
  'index.reindexFailed': {
    en: 'CodeGraph re-index failed: {0}',
    zh: 'CodeGraph 重新索引失败: {0}',
  },

  // ---- 连接相关 ----
  'connect.failed': {
    en: 'CodeGraph connection failed: {0}',
    zh: 'CodeGraph 连接失败: {0}',
  },
  'connect.retryIn': {
    en: 'CodeGraph connection failed ({0}). Retrying in {1}s...',
    zh: 'CodeGraph 连接失败（{0}）。{1}秒后重试...',
  },
  'connect.maxRetries': {
    en: 'CodeGraph failed to start after {0} attempts. Error: {1}',
    zh: 'CodeGraph 启动失败，已重试 {0} 次。错误: {1}',
  },
  'connect.crashed': {
    en: 'CodeGraph server process exited unexpectedly (code {0}). Click the status bar to retry.',
    zh: 'CodeGraph 服务进程意外退出（代码 {0}）。点击状态栏重试。',
  },

  // ---- 搜索相关 ----
  'search.prompt': {
    en: 'Enter symbol name to search',
    zh: '输入要搜索的符号名称',
  },
  'search.placeholder': {
    en: 'e.g., getUnresolvedReferences',
    zh: '例如: getUnresolvedReferences',
  },
  'search.failed': {
    en: 'Search failed: {0}',
    zh: '搜索失败: {0}',
  },
  'search.foundResults': {
    en: 'Found {0} results',
    zh: '找到 {0} 个结果',
  },
  'search.callersOf': {
    en: 'Callers of {0} ({1} results)',
    zh: '{0} 的调用者（{1} 个结果）',
  },
  'search.calleesOf': {
    en: 'Callees of {0} ({1} results)',
    zh: '{0} 的被调用者（{1} 个结果）',
  },
  'search.impactOf': {
    en: 'Impact of {0} ({1} results)',
    zh: '{0} 的影响分析（{1} 个结果）',
  },
  'search.queryFailed': {
    en: '{0} query failed: {1}',
    zh: '{0} 查询失败: {1}',
  },
  'search.errorPrefix': {
    en: 'CodeGraph error: {0}',
    zh: 'CodeGraph 错误: {0}',
  },

  // ---- 错误信息 ----
  'error.activationFailed': {
    en: 'CodeGraph extension failed to activate: {0}. Check the Output panel for details.',
    zh: 'CodeGraph 扩展激活失败: {0}。请查看输出面板了解详情。',
  },
  'error.commandNotFound': {
    en: 'codegraph command not found. Please install CodeGraph.',
    zh: '未找到 codegraph 命令。请安装 CodeGraph。',
  },
  'error.processExited': {
    en: 'CodeGraph process exited with code {0}',
    zh: 'CodeGraph 进程退出，代码: {0}',
  },
  'error.processKilled': {
    en: 'CodeGraph process killed by signal {0}',
    zh: 'CodeGraph 进程被信号 {0} 终止',
  },
  'error.processClosed': {
    en: 'CodeGraph process closed',
    zh: 'CodeGraph 进程已关闭',
  },
  'error.stdinNotAvailable': {
    en: 'Process stdin not available',
    zh: '进程 stdin 不可用',
  },
  'error.writeFailed': {
    en: 'Failed to write to codegraph stdin: {0}',
    zh: '写入 codegraph stdin 失败: {0}',
  },
  'error.spawnFailed': {
    en: 'Failed to start codegraph: {0}',
    zh: '启动 codegraph 失败: {0}',
  },
  'error.stdioFailed': {
    en: 'Failed to spawn process with stdio pipes',
    zh: '无法使用 stdio 管道启动进程',
  },
  'error.clientStopped': {
    en: 'Client stopped',
    zh: '客户端已停止',
  },
  'error.notReady': {
    en: 'MCP client not ready. Did you call start()?',
    zh: 'MCP 客户端未就绪。是否已调用 start()？',
  },

  // ---- 输出通道 ----
  'output.channelName': {
    en: 'CodeGraph',
    zh: 'CodeGraph',
  },

  // ---- 状态栏 ----
  'statusBar.notInitialized': {
    en: 'CodeGraph: Not initialized',
    zh: 'CodeGraph: 未初始化',
  },
  'statusBar.installing': {
    en: 'CodeGraph: Installing...',
    zh: 'CodeGraph: 安装中...',
  },
  'statusBar.indexing': {
    en: 'CodeGraph: Indexing...',
    zh: 'CodeGraph: 索引中...',
  },
  'statusBar.ready': {
    en: 'CodeGraph: Ready',
    zh: 'CodeGraph: 已就绪',
  },
  'statusBar.error': {
    en: 'CodeGraph: Error',
    zh: 'CodeGraph: 错误',
  },

  // ---- 扩展激活 ----
  'extension.activating': {
    en: 'CodeGraph extension activating...',
    zh: 'CodeGraph 扩展正在激活...',
  },
  'extension.activated': {
    en: 'CodeGraph extension activated successfully.',
    zh: 'CodeGraph 扩展激活成功。',
  },
  'extension.deactivating': {
    en: 'CodeGraph extension deactivating...',
    zh: 'CodeGraph 扩展正在停用...',
  },
} as const;

// =============================================================================
// 翻译函数
// =============================================================================

/** 所有消息键类型 */
export type MessageKey = keyof typeof messages;

/**
 * 获取本地化文案。
 *
 * 根据 VS Code 显示语言自动选择中文或英文文案。
 * 支持 {0}, {1}, {2} 等占位符替换。
 *
 * @param key - 文案键名
 * @param args - 替换参数
 * @returns 格式化后的文案字符串
 *
 * @example
 * t('prompt.noResultsFor', 'MyClass')
 * // zh: '未找到 "MyClass" 的结果。'
 * // en: 'No results found for "MyClass".'
 */
export function t(key: MessageKey, ...args: (string | number)[]): string {
  const entry = messages[key];
  if (!entry) return key;

  // 根据 VS Code 语言选择中文或英文
  // Explicitly type as string to avoid literal type narrowing from `as const`
  let text: string = isChinese() ? entry.zh : entry.en;

  // 替换占位符 {0}, {1}, {2}...
  args.forEach((arg, index) => {
    text = text.replace(new RegExp(`\\{${index}\\}`, 'g'), String(arg));
  });

  return text;
}
