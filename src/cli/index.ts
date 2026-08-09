import { pathToFileURL } from "node:url";

export function main(): void {
  console.log("MiniCode CLI");
}

// 直接运行时执行（node/tsx 入口）；被 import 时不执行
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
