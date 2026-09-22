#!/usr/bin/env bash
# 安全模型测试：默认私有 + 分享链接 + 编辑历史。
#
# 用法: scripts/security-test.sh [base-url]
#
# 默认针对私有模式实例（8789），即**不设置** WEBDAV_PUBLIC_READ 的默认配置。
# 本地可以这样起一个实例：
#   npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state --port 8789 \
#     --binding WEBDAV_PUBLIC_READ=0 --binding WEBDAV_PUBLIC_THUMBNAILS=0
set -uo pipefail

BASE="${1:-http://127.0.0.1:8789}"
ADMIN="admin:secret"
USER1="user1:pass1"
PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (期望 %s, 实际 %s)\n' "$1" "$2" "$3"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
atleast(){ if [ "${3:-0}" -ge "$2" ]; then ok "$1"; else bad "$1" ">=$2" "$3"; fi; }
section(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }
acode() { curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN" "$@"; }
u1code(){ curl -s -o /dev/null -w '%{http_code}' -u "$USER1" "$@"; }

W="$BASE/webdav/_sec"
WOTHER="$BASE/webdav/_sec-other"

# 清理上次残留
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$W"
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$WOTHER"

section "1. 准备数据"
check "建目录" 201 "$(acode -X MKCOL "$W")"
check "建子目录" 201 "$(acode -X MKCOL "$W/sub")"
check "写入 a.txt" 201 "$(acode -X PUT --data-binary 'secret-a' "$W/a.txt")"
check "写入 sub/b.txt" 201 "$(acode -X PUT --data-binary 'secret-b' "$W/sub/b.txt")"
check "写入兄弟目录文件" 201 "$(acode -X MKCOL "$WOTHER" >/dev/null; acode -X PUT --data-binary 'secret-other' "$WOTHER/c.txt")"

section "2. 默认全私有：匿名一律被拒"
check "匿名 /api/whoami 200（只是探测）" 200 "$(code "$BASE/api/whoami")"
check "whoami publicRead=false" "false" "$(curl -s "$BASE/api/whoami" | grep -o '"publicRead":[a-z]*' | cut -d: -f2)"
check "whoami publicThumbnails=false" "false" "$(curl -s "$BASE/api/whoami" | grep -o '"publicThumbnails":[a-z]*' | cut -d: -f2)"
check "匿名 /api/list/ 401" 401 "$(code "$BASE/api/list/")"
check "匿名 /api/list/{目录} 401" 401 "$(code "$BASE/api/list/_sec")"
check "匿名 /raw/{已知文件} 401" 401 "$(code "$BASE/raw/_sec/a.txt")"
check "匿名 /webdav/ PROPFIND 401" 401 "$(code -X PROPFIND -H 'Depth: 1' "$BASE/webdav/")"
check "匿名 /webdav/{文件} GET 401" 401 "$(code "$BASE/webdav/_sec/a.txt")"
check "匿名 /api/zip/{目录} 401" 401 "$(code "$BASE/api/zip/_sec")"
check "匿名 /api/keys 401" 401 "$(code "$BASE/api/keys")"
check "匿名 /api/shares 401" 401 "$(code "$BASE/api/shares")"
check "匿名 /api/versions/list/{key} 401" 401 "$(code "$BASE/api/versions/list/_sec/a.txt")"
check "匿名猜路径也拿不到内容" "需要登录" "$(curl -s "$BASE/raw/_sec/a.txt" | head -c 12)"
check "匿名 /s/{不存在token} 404" 404 "$(code "$BASE/s/s_00000000000000000000")"
check "匿名 /s/{格式非法} 404" 404 "$(code "$BASE/s/not-a-token")"

section "3. 已认证可正常使用"
check "admin /api/list/ 200" 200 "$(acode "$BASE/api/list/")"
check "admin /raw/{文件} 200" 200 "$(acode "$BASE/raw/_sec/a.txt")"
check "admin 读回内容" "secret-a" "$(curl -s -u "$ADMIN" "$BASE/raw/_sec/a.txt")"
check "admin PROPFIND 207" 207 "$(acode -X PROPFIND -H 'Depth: 1' "$BASE/webdav/")"

section "4. 内部保留目录谁都不能直接读"
check "admin 读 shares 目录被拒 404" 404 "$(acode "$BASE/raw/_%24flaredrive%24/shares/x.json")"
check "admin 读 versions 目录被拒 404" 404 "$(acode "$BASE/raw/_%24flaredrive%24/versions/x.bin")"
check "admin PROPFIND 内部目录 404" 404 "$(acode -X PROPFIND -H 'Depth: 0' "$BASE/webdav/_%24flaredrive%24/shares")"
check "admin list 内部目录 404" 404 "$(acode "$BASE/api/list/_%24flaredrive%24/shares")"
check "匿名也一样 404" 404 "$(code "$BASE/raw/_%24flaredrive%24/shares/x.json")"

section "5. 分享链接：文件"
SHARE="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt"}' "$BASE/api/shares")"
TOKEN="$(printf '%s' "$SHARE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
TYPE="$(printf '%s' "$SHARE" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)"
atleast "创建文件分享返回 token" 1 "$(printf '%s' "$TOKEN" | grep -c '^s_')"
check "类型识别为 file" "file" "$TYPE"
check "匿名访问分享链接 200" 200 "$(code "$BASE/s/$TOKEN")"
check "匿名读到分享内容" "secret-a" "$(curl -s "$BASE/s/$TOKEN")"
check "匿名 HEAD 分享 200" 200 "$(code -I "$BASE/s/$TOKEN")"
check "匿名 Range 分享 206" 206 "$(code -H 'Range: bytes=0-5' "$BASE/s/$TOKEN")"
check "匿名强制下载头" 1 "$(curl -s -D- -o /dev/null "$BASE/s/$TOKEN?download=1" | grep -ci '^content-disposition: attachment')"
check "分享响应带 noindex" 1 "$(curl -s -D- -o /dev/null "$BASE/s/$TOKEN" | grep -ci 'x-robots-tag: noindex')"
check "文件分享不能越权访问子路径 404" 404 "$(code "$BASE/s/$TOKEN/whatever")"
check "文件分享不能越权访问兄弟文件 404" 404 "$(code --path-as-is "$BASE/s/$TOKEN/../_sec-other/c.txt")"
check "重复创建同一 key 复用同一条 200" 200 "$(code -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt"}' "$BASE/api/shares")"

section "6. 分享链接：目录"
DSHARE="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec"}' "$BASE/api/shares")"
DTOKEN="$(printf '%s' "$DSHARE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
DTYPE="$(printf '%s' "$DSHARE" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)"
check "目录分享类型为 folder" "folder" "$DTYPE"
check "匿名打开目录分享 200" 200 "$(code "$BASE/s/$DTOKEN")"
atleast "目录页列出文件名" 1 "$(curl -s "$BASE/s/$DTOKEN" | grep -c 'a.txt')"
atleast "目录页列出子目录" 1 "$(curl -s "$BASE/s/$DTOKEN" | grep -c '"name":"sub"')"
check "目录页不整站可导航（无 /webdav 链接）" 0 "$(curl -s "$BASE/s/$DTOKEN" | grep -c 'href=\\"/webdav')"
check "目录页只有只读操作（无写接口）" 0 "$(curl -s "$BASE/s/$DTOKEN" | grep -cE 'method=\\?"(PUT|DELETE|POST)\\"')"
atleast "目录页提供预览入口" 1 "$(curl -s "$BASE/s/$DTOKEN" | grep -c '预览')"
atleast "目录页提供下载入口" 1 "$(curl -s "$BASE/s/$DTOKEN" | grep -c '下载')"
check "匿名读分享目录内文件 200" 200 "$(code "$BASE/s/$DTOKEN/sub/b.txt")"
check "匿名读分享目录内文件内容" "secret-b" "$(curl -s "$BASE/s/$DTOKEN/sub/b.txt")"
check "匿名列分享子目录 200" 200 "$(code "$BASE/s/$DTOKEN/sub/")"
check "越权访问兄弟目录 404" 404 "$(code --path-as-is "$BASE/s/$DTOKEN/../_sec-other/c.txt")"
check "越权访问上级目录 404" 404 "$(code --path-as-is "$BASE/s/$DTOKEN/../../docs/hello.txt")"
check "百分号编码的 .. 也被拒 404" 404 "$(code --path-as-is "$BASE/s/$DTOKEN/%2e%2e/%2e%2e/docs/hello.txt")"
check "越权访问内部目录 404" 404 "$(code "$BASE/s/$DTOKEN/_%24flaredrive%24/shares")"
check "分享目录打包 200" 200 "$(code "$BASE/s/$DTOKEN?zip=1")"
curl -s "$BASE/s/$DTOKEN?zip=1" -o /tmp/sec-share.zip
check "分享打包是合法 zip" "PK" "$(head -c 2 /tmp/sec-share.zip)"
if command -v unzip >/dev/null 2>&1; then
  atleast "分享 zip 内含文件" 1 "$(unzip -l /tmp/sec-share.zip 2>/dev/null | grep -c 'a.txt')"
  check "分享 zip 不含越权内容" 0 "$(unzip -l /tmp/sec-share.zip 2>/dev/null | grep -c 'secret-other')"
fi

section "7. 分享的权限与吊销"
check "受限账号分享别人的目录 403" 403 "$(u1code -X POST -H 'Content-Type: application/json' -d '{"key":"_sec"}' "$BASE/api/shares")"
check "受限账号只能看到自己的分享" 0 "$(curl -s -u "$USER1" "$BASE/api/shares" | grep -c "$DTOKEN")"
check "受限账号吊销别人的分享 403" 403 "$(u1code -X DELETE "$BASE/api/shares/$DTOKEN")"
check "内部目录不能分享 403" 403 "$(acode -X POST -H 'Content-Type: application/json' -d '{"key":"_$flaredrive$/shares"}' "$BASE/api/shares")"
check "不存在的路径不能分享 404" 404 "$(acode -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/不存在"}' "$BASE/api/shares")"
check "吊销文件分享 204" 204 "$(acode -X DELETE "$BASE/api/shares/$TOKEN")"
check "吊销后匿名 404" 404 "$(code "$BASE/s/$TOKEN")"
check "吊销目录分享 204" 204 "$(acode -X DELETE "$BASE/api/shares/$DTOKEN")"
check "吊销后目录分享 404" 404 "$(code "$BASE/s/$DTOKEN")"
check "重复吊销 404" 404 "$(acode -X DELETE "$BASE/api/shares/$DTOKEN")"

section "8. 编辑历史与回退"
VW="$BASE/webdav/_sec/ver.txt"
acode -X PUT --data-binary 'v1' "$VW" >/dev/null
check "覆盖写带 fd-snapshot 201" 201 "$(acode -X PUT -H 'fd-snapshot: 1' --data-binary 'v2' "$VW")"
check "当前内容为 v2" "v2" "$(curl -s -u "$ADMIN" "$BASE/raw/_sec/ver.txt")"
VLIST="$(curl -s -u "$ADMIN" "$BASE/api/versions/list/_sec/ver.txt")"
atleast "历史里出现 1 个版本" 1 "$(printf '%s' "$VLIST" | grep -o '"id":' | wc -l | tr -d ' ')"
VID="$(printf '%s' "$VLIST" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
check "版本内容为 v1" "v1" "$(curl -s -u "$ADMIN" "$BASE/api/versions/content/_sec/ver.txt/$VID")"
check "不带 fd-snapshot 的覆盖不产生快照" 201 "$(acode -X PUT --data-binary 'v3' "$VW")"
atleast "版本数仍为 1" 1 "$(printf '%s' "$(curl -s -u "$ADMIN" "$BASE/api/versions/list/_sec/ver.txt")" | grep -o '"id":' | wc -l | tr -d ' ')"
check "恢复 v1 200" 200 "$(acode -X POST "$BASE/api/versions/restore/_sec/ver.txt/$VID")"
check "恢复后内容为 v1" "v1" "$(curl -s -u "$ADMIN" "$BASE/raw/_sec/ver.txt")"
atleast "恢复本身也留了快照（版本变多）" 2 "$(printf '%s' "$(curl -s -u "$ADMIN" "$BASE/api/versions/list/_sec/ver.txt")" | grep -o '"id":' | wc -l | tr -d ' ')"
check "删除某个版本 204" 204 "$(acode -X DELETE "$BASE/api/versions/remove/_sec/ver.txt/$VID")"
check "删除不存在的版本 404" 404 "$(acode -X DELETE "$BASE/api/versions/remove/_sec/ver.txt/1758520000000-abcdef")"
check "受限账号读他人 key 的历史 403" 403 "$(u1code "$BASE/api/versions/list/_sec/ver.txt")"
check "匿名列历史 401" 401 "$(code "$BASE/api/versions/list/_sec/ver.txt")"
check "匿名读历史内容 401" 401 "$(code "$BASE/api/versions/content/_sec/ver.txt/$VID")"

section "9. 清理"
check "删除测试目录" 204 "$(acode -X DELETE "$W")"
check "删除兄弟目录" 204 "$(acode -X DELETE "$WOTHER")"

printf '\n\033[1m结果: %d 通过, %d 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
