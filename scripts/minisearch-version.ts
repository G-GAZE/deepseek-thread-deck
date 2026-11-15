import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * 读取已安装依赖的真实版本，供构建期 `vite.define` 注入版本戳。
 *
 * 为什么不用 `require('pkg/package.json')`：部分包（如 minisearch）的 `exports`
 * 不暴露 `./package.json`，会直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
 * 这里先解析包入口，再向上找 `name` 匹配的 package.json。
 */
export function resolvePackageVersion(packageName: string): string {
  const require = createRequire(import.meta.url);
  let directory = dirname(require.resolve(packageName));

  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (parsed.name === packageName && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // 该层没有 package.json，继续向上找。
    }
    directory = dirname(directory);
  }

  throw new Error(`无法解析 ${packageName} 的版本（找不到包根 package.json）`);
}
