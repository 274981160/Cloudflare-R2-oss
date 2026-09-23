/**
 * 前端纯函数自测（零依赖，直接 `node scripts/frontend-test.mjs` 运行）。
 *
 * 覆盖 assets/main.mjs 里的文本工具：JSON/JSONC 整理缩进、缩进风格探测、
 * BOM/CRLF 保留、严格程度判定。这些函数不碰 DOM，所以能在 Node 里直接跑。
 *
 * 为什么单独立出来：在线编辑器的「整理缩进」直接改用户文件，
 * 必须保证「只动空白、不动内容」——这里就是这条底线的回归测试。
 */
import {
  classifyJsonText,
  formatDate,
  detectJsonIndent,
  prettyJsonText,
  splitBom,
  stripJsonComments,
} from "../assets/main.mjs";

let pass = 0;
let fail = 0;

function check(name, actual, expected) {
  if (actual === expected) {
    pass += 1;
    console.log(`  \u001b[32mok\u001b[0m   ${name}`);
    return;
  }
  fail += 1;
  console.log(
    `  \u001b[31mFAIL\u001b[0m ${name}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`
  );
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

section("1. 整理缩进：基本重排");
check(
  "压缩成一行 → 多行缩进",
  prettyJsonText('{"a":1,"b":[1,2],"c":{"d":true}}').text,
  '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ],\n  "c": {\n    "d": true\n  }\n}'
);
check("空对象/空数组保持内联", prettyJsonText('{"a":{},"b":[]}').text, '{\n  "a": {},\n  "b": []\n}');
check("已整理则报告无变化", prettyJsonText('{\n  "a": 1\n}\n').changed, false);
check("纯文本不处理", prettyJsonText("hello world").changed, false);
check("整理结果幂等", prettyJsonText(prettyJsonText('{"a":[1,{"b":2}]}').text).changed, false);

section("2. 只动空白：内容必须逐字保留");
const tricky = '{"a":1.0,"b":1e2,"c":-0,"d":123456789012345678901,"e":"hello   world","f":"tab\\there"}';
const trickyOut = prettyJsonText(tricky).text;
for (const fragment of ["1.0", "1e2", "-0", "123456789012345678901", "hello   world", "tab\\there"]) {
  check(`保留原样 ${fragment}`, trickyOut.includes(fragment), true);
}
check("重复键不被合并", (prettyJsonText('{"a":1,"a":2}').text.match(/"a":/g) || []).length, 2);
check(
  "非空白字符完全一致",
  trickyOut.replace(/\s+/g, ""),
  tricky.replace(/\s+/g, "")
);
const broken = '{"a": "unterminated}';
check(
  "未闭合字符串不丢字符",
  prettyJsonText(broken).text.replace(/\s+/g, ""),
  broken.replace(/\s+/g, "")
);

section("3. JSONC：注释与尾逗号必须保留");
const jsonc = '{\n// 行注释\n"a": 1, /* 块注释 */\n"b": 2,\n}';
const jsoncOut = prettyJsonText(jsonc).text;
check("保留行注释", jsoncOut.includes("// 行注释"), true);
check("保留块注释", jsoncOut.includes("/* 块注释 */"), true);
check("保留尾逗号", jsoncOut.includes("2,"), true);
check("非空白内容一致", jsoncOut.replace(/\s+/g, ""), jsonc.replace(/\s+/g, ""));

section("4. BOM 与换行风格");
const withBom = '\uFEFF{"a":1}';
check("BOM 原样保留", prettyJsonText(withBom).text.charCodeAt(0) === 0xfeff, true);
check("splitBom 去 BOM", splitBom(withBom)[1], '{"a":1}');
check("splitBom 标记无 BOM", splitBom('{"a":1}')[0], false);
const crlf = '{\r\n"a":1\r\n}';
check("CRLF 保留", prettyJsonText(crlf).text.includes("\r\n"), true);
check("不混入裸 LF", /[^\r]\n/.test(prettyJsonText(crlf).text), false);
check("结尾换行保留", prettyJsonText('{"a":1}\n').text.endsWith("\n"), true);
check("原本无结尾换行则不添加", prettyJsonText('{"a":1}').text.endsWith("\n"), false);

section("5. 缩进风格探测");
check("探测 4 空格", detectJsonIndent('{\n    "a": 1\n}'), "    ");
check("探测 2 空格", detectJsonIndent('{\n  "a": 1\n}'), "  ");
check("探测制表符", detectJsonIndent('{\n\t"a": 1\n}'), "\t");
check("无缩进时默认 2 空格", detectJsonIndent('{"a":1}'), "  ");
check("指定缩进生效", prettyJsonText('{"a":{"b":1}}', { indent: "    " }).text.includes('\n    "a"'), true);

section("6. 严格程度判定（决定状态条文案）");
check("严格 JSON", classifyJsonText('{"a":1}'), "valid");
check("带注释的 JSONC 不算错误", classifyJsonText(jsonc), "jsonc");
check("带 BOM 的严格 JSON", classifyJsonText(withBom), "valid");
check("语法错误", classifyJsonText('{"a": }'), "invalid");
check("空内容", classifyJsonText("   "), "empty");

section("7. 列表日期格式（越近越简短）");
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
check("今天的显示为「今天 HH:MM」", formatDate(now.toISOString()), `今天 ${clock}`);
const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5);
check("昨天显示为「昨天 HH:MM」", formatDate(yesterday.toISOString()), "昨天 09:05");
const sameYear = new Date(now.getFullYear(), 0, 15, 8, 30);
const expectedSameYear = now.getMonth() === 0 && now.getDate() === 15 ? `今天 ${clock}` : "01-15 08:30";
check("同年显示为「MM-DD HH:MM」", formatDate(sameYear.toISOString()), expectedSameYear);
check("跨年只显示日期", formatDate(new Date(now.getFullYear() - 2, 4, 6).toISOString()), `${now.getFullYear() - 2}-05-06`);
check("空值返回空串", formatDate(null), "");

section("8. 注释剥离（仅用于判定，不写回文件）");
check("剥离行注释", stripJsonComments('{"a":1//x\n}').includes("//"), false);
check("剥离块注释", stripJsonComments('{/*x*/"a":1}').includes("/*"), false);
check("字符串里的 // 不当注释", stripJsonComments('{"u":"http://x"}').includes("http://x"), true);

console.log(`\n\u001b[1m结果: ${pass} 通过, ${fail} 失败\u001b[0m`);
process.exit(fail === 0 ? 0 : 1);
