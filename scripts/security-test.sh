#!/usr/bin/env bash
# 安全模型测试：默认私有 + 分享链接 + 下载签名 + PROPFIND 兼容性。
#
# 用法: scripts/security-test.sh [base-url]
#
# 默认针对私有模式实例（8789），即**不设置** WEBDAV_PUBLIC_READ 的默认配置。
# 本地可以这样起一个实例：
#   npx wrangler pages dev . --r2 BUCKET --persist-to .wrangler/state --port 8789 \
#     --binding WEBDAV_PUBLIC_READ=0 --binding WEBDAV_PUBLIC_THUMBNAILS=0
set -uo pipefail

BASE="${1:-http://127.0.0.1:8791}"
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
# 删除现在会进回收站，残留会挡住同名重建 → 顺手清空回收站，保证脚本可反复执行
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$BASE/api/trash"
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
# 有效期：显式指定时必须能更新已有分享（原来复用时不生效，用户设了也没用）
EXP7="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt","expiresInDays":7}' "$BASE/api/shares" | grep -o '"expiresAt":"[^"]*"' | cut -d'"' -f4)"
atleast "分享可设 7 天有效期" 1 "$(printf '%s' "$EXP7" | grep -c 'T')"
EXP1="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt","expiresInDays":1}' "$BASE/api/shares" | grep -o '"expiresAt":"[^"]*"' | cut -d'"' -f4)"
check "复用分享时更新有效期（7 天 → 1 天）" "different" "$([ "$EXP7" != "$EXP1" ] && echo different || echo same)"
check "可改回永久（expiresAt=null）" 1 "$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt","expiresInDays":null}' "$BASE/api/shares" | grep -c '"expiresAt":null')"
check "非法有效期 400" 400 "$(code -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/a.txt","expiresInDays":"abc"}' "$BASE/api/shares")"
check "分享列表只有一条记录（复用而非新增）" 1 "$(curl -s -u "$ADMIN" "$BASE/api/shares" | grep -o '"_sec/a.txt"' | wc -l | tr -d ' ')"

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

section "8. 下载签名直链"
check "匿名取签名 401" 401 "$(code "$BASE/api/sign?key=_sec/a.txt")"
check "缺 key 参数 400" 400 "$(acode "$BASE/api/sign")"
check "不存在的对象 404" 404 "$(acode "$BASE/api/sign?key=_sec/不存在.txt")"
check "受限账号签他人路径 403" 403 "$(u1code "$BASE/api/sign?key=_sec/a.txt")"
SIGN="$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_sec/a.txt")"
SURL="$(printf '%s' "$SIGN" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)"
atleast "admin 取到签名 URL" 1 "$(printf '%s' "$SURL" | grep -c '/raw/_sec/a.txt?exp=')"
check "签名直链匿名可下载 200" 200 "$(code "$BASE$SURL")"
check "签名直链内容正确" "secret-a" "$(curl -s "$BASE$SURL")"
check "篡改签名被拒 401" 401 "$(code "$BASE/raw/_sec/a.txt?exp=9999999999&sig=deadbeef")"
check "只有 exp 没有 sig 被拒 401" 401 "$(code "$BASE/raw/_sec/a.txt?exp=9999999999")"
SIGFOLDER="$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_sec" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)"
atleast "目录签名指向 zip 接口" 1 "$(printf '%s' "$SIGFOLDER" | grep -c '/api/zip/_sec?exp=')"
check "目录签名匿名打包 200" 200 "$(code "$BASE$SIGFOLDER")"
curl -s "$BASE$SIGFOLDER" -o /tmp/sign-share.zip
check "目录签名打包是合法 zip" "PK" "$(head -c 2 /tmp/sign-share.zip)"
check "签名不能读到别的对象 401" 401 "$(code "$BASE/raw/_sec/sub/b.txt?exp=9999999999&sig=deadbeef")"

section "8.5 PROPFIND 响应（Android 客户端兼容）"
PFROOT="$(curl -s -u "$ADMIN" -X PROPFIND -H 'Depth: 1' "$BASE/webdav/")"
atleast "默认命名空间 multistatus" 1 "$(printf '%s' "$PFROOT" | grep -c '<multistatus xmlns="DAV:"')"
check "无 D: 前缀" 0 "$(printf '%s' "$PFROOT" | grep -c '<D:')"
check "无 fd: 前缀" 0 "$(printf '%s' "$PFROOT" | grep -c '<fd:')"
atleast "按标签名能找到 response" 1 "$(printf '%s' "$PFROOT" | grep -c '<response>')"
atleast "按标签名能找到 href" 1 "$(printf '%s' "$PFROOT" | grep -c '<href>')"
check "无嵌套 lockdiscovery" 0 "$(printf '%s' "$PFROOT" | grep -c '<lockdiscovery>')"
atleast "集合标记 resourcetype" 1 "$(printf '%s' "$PFROOT" | grep -c '<collection />')"
# 文件夹 href 以 / 结尾（标准客户端要求）
FHREF="$(printf '%s' "$PFROOT" | grep -o '<href>[^<]*/</href>' | head -1)"
atleast "目录 href 以 / 结尾" 1 "$(printf '%s' "$FHREF" | grep -c '/</href>')"

section "8.6 回收站：内容不能经分享/签名泄漏"
check "写入待回收文件 201" 201 "$(acode -X PUT --data 'trash-secret' "$W/trash-share.txt")"
TSHARE="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"key":"_sec/trash-share.txt"}' "$BASE/api/shares")"
TTOKEN="$(printf '%s' "$TSHARE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
check "分享可用 200" 200 "$(code "$BASE/s/$TTOKEN")"
check "删除该文件 204" 204 "$(acode -X DELETE "$W/trash-share.txt")"
check "回收后分享链接 404" 404 "$(code "$BASE/s/$TTOKEN")"
check "回收后签名接口 404" 404 "$(acode "$BASE/api/sign?key=_sec/trash-share.txt")"
check "回收后已认证直链 404" 404 "$(acode "$BASE/raw/_sec/trash-share.txt")"
check "回收后匿名直链仍是 401（私有模式）" 401 "$(code "$BASE/raw/_sec/trash-share.txt")"
check "受限账号看不到别人删的" 0 "$(curl -s -u "$USER1" "$BASE/api/trash" | grep -c 'trash-share')"
TID="$(curl -s -u "$ADMIN" "$BASE/api/trash" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_sec/trash-share.txt']
print(hit[0] if hit else '')" 2>/dev/null)"
check "受限账号不能恢复别人的 403" 403 "$(u1code -X POST "$BASE/api/trash/$TID/restore")"
check "受限账号不能彻底删别人的 403" 403 "$(u1code -X DELETE "$BASE/api/trash/$TID")"
check "管理员恢复 200" 200 "$(acode -X POST "$BASE/api/trash/$TID/restore")"
check "恢复后分享又能访问" "trash-secret" "$(curl -s "$BASE/s/$TTOKEN")"
check "恢复后再删一次 204" 204 "$(acode -X DELETE "$W/trash-share.txt")"
TID2="$(curl -s -u "$ADMIN" "$BASE/api/trash" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_sec/trash-share.txt']
print(hit[0] if hit else '')" 2>/dev/null)"
check "彻底删除 200" 200 "$(acode -X DELETE "$BASE/api/trash/$TID2")"
check "吊销该分享 204" 204 "$(acode -X DELETE "$BASE/api/shares/$TTOKEN")"
check "内部目录仍不能写入 403" 403 "$(acode -X POST -F 'file=@/tmp/smoke-upload.txt' "$BASE/api/upload/_%24flaredrive%24/trash/evil.json")"

section "8.7 同名预检不能变成路径探测工具"
check "匿名预检 401" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"keys":["_sec/a.txt"]}' "$BASE/api/exists")"
check "受限账号查范围外路径不泄漏存在性" "[]" "$(curl -s -u "$USER1" -X POST -H 'Content-Type: application/json' -d '{"keys":["_sec/a.txt"]}' "$BASE/api/exists" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['existing']))")"
check "受限账号查自己范围内正常返回" 201 "$(u1code -X PUT --data 'mine' "$BASE/webdav/user1/probe.txt")"
atleast "自己范围内能查到" 1 "$(curl -s -u "$USER1" -X POST -H 'Content-Type: application/json' -d '{"keys":["user1/probe.txt"]}' "$BASE/api/exists" | grep -c 'probe')"
check "清理探针 204" 204 "$(u1code -X DELETE "$BASE/webdav/user1/probe.txt")"

section "8.8 覆盖保护与回收站内容不泄漏"
check "写入待覆盖文件 201" 201 "$(acode -X PUT --data 'old-secret' "$W/overwrite-secret.txt")"
check "覆盖写入 201" 201 "$(acode -X PUT --data 'new-content' "$W/overwrite-secret.txt")"
check "覆盖后新内容生效" "new-content" "$(curl -s -u "$ADMIN" "$W/overwrite-secret.txt")"
OVT="$(curl -s -u "$ADMIN" "$BASE/api/trash" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_sec/overwrite-secret.txt']
print(hit[0] if hit else '')" 2>/dev/null)"
atleast "被覆盖的旧版本进了回收站" 1 "$(printf '%s' "$OVT" | grep -c .)"
check "受限账号看不到这条记录" 0 "$(curl -s -u "$USER1" "$BASE/api/trash" | grep -c 'overwrite-secret')"
check "受限账号不能恢复它 403" 403 "$(u1code -X POST "$BASE/api/trash/$OVT/restore")"
check "回收站内部对象路径一律当作不存在（404）" 404 "$(acode "$BASE/raw/_%24flaredrive%24/trash/objects")"
check "回收站记录 JSON 也不可直接读" 404 "$(acode "$BASE/raw/_%24flaredrive%24/trash/")"
check "回收站目录不出现在列表里" 404 "$(acode "$BASE/api/list/_%24flaredrive%24/trash")"
check "管理员恢复旧版本 200" 200 "$(acode -X POST "$BASE/api/trash/$OVT/restore")"
check "旧内容确实找回了" "old-secret" "$(curl -s -u "$ADMIN" "$W/overwrite-secret.txt%20(%E6%81%A2%E5%A4%8D)")"
check "清理覆盖测试文件 204" 204 "$(acode -X DELETE "$W/overwrite-secret.txt")"
check "清理恢复出来的文件 204" 204 "$(acode -X DELETE "$W/overwrite-secret.txt%20(%E6%81%A2%E5%A4%8D)")"

section "8.9 预览签名（私有模式下不能靠伪造签名绕过）"
check "无签名直链 401" 401 "$(code "$BASE/raw/_sec/a.txt")"
check "伪造签名 401" 401 "$(code "$BASE/raw/_sec/a.txt?exp=9999999999&sig=deadbeef")"
check "签名参数不全会 401" 401 "$(code "$BASE/raw/_sec/a.txt?exp=9999999999")"
check "真签名可匿名读 200" 200 "$(SIGNURL="$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_sec/a.txt" | python3 -c "
import json,sys
print(json.load(sys.stdin)['url'])" 2>/dev/null)"; code "$BASE$SIGNURL")"
check "签名只对签的那个 key 有效" 401 "$(SIGNURL="$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_sec/a.txt" | python3 -c "
import json,sys
print(json.load(sys.stdin)['url'])" 2>/dev/null)"; code "$BASE/raw/_sec/sub/b.txt?${SIGNURL#*?}")"
check "过期签名 401" 401 "$(code "$BASE/raw/_sec/a.txt?exp=1000000000&sig=deadbeef")"

section "8.10 预览 token：只读、只对 /raw、不能越权"
PT="$(curl -s -u "$ADMIN" "$BASE/api/whoami" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('previewToken') or '')" 2>/dev/null)"
PT1="$(curl -s -u "$USER1" "$BASE/api/whoami" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('previewToken') or '')" 2>/dev/null)"
atleast "管理员有预览 token" 1 "$(printf '%s' "$PT" | grep -c .)"
check "有效 token 可匿名读直链" 200 "$(code "$BASE/raw/_sec/a.txt?pt=$PT")"
check "匿名无 token 仍 401" 401 "$(code "$BASE/raw/_sec/a.txt")"
check "篡改账号名 401" 401 "$(code "$BASE/raw/_sec/a.txt?pt=user2.$(printf '%s' "$PT" | cut -d. -f2,3)")"
check "伪造签名 401" 401 "$(code "$BASE/raw/_sec/a.txt?pt=admin.$(printf '%s' "$PT" | cut -d. -f2).deadbeef")"
check "过期 token 401" 401 "$(code "$BASE/raw/_sec/a.txt?pt=admin.1000000000.$(printf '%s' "$PT" | cut -d. -f3)")"
check "受限账号的 token 读不了别人的文件" 401 "$(code "$BASE/raw/_sec/a.txt?pt=$PT1")"
check "受限账号的 token 能读自己的文件" 200 "$(code "$BASE/raw/user1/mine.txt?pt=$PT1")"
check "token 不能当认证头列目录 401" 401 "$(code -H "Authorization: Bearer $PT" "$BASE/api/list/_sec")"
check "token 不能当认证头写文件 401" 401 "$(code -H "Authorization: Bearer $PT" -X PUT --data 'x' "$BASE/webdav/_sec/evil.txt")"
check "?pt 对非 /raw 接口无效 401" 401 "$(code "$BASE/api/list/_sec?pt=$PT")"
check "?pt 对 webdav 无效 401" 401 "$(code "$BASE/webdav/_sec/a.txt?pt=$PT")"
check "清理越权测试残留 404" 404 "$(acode "$BASE/raw/_sec/evil.txt")"

section "9. 清理"
check "删除测试目录" 204 "$(acode -X DELETE "$W")"
check "删除兄弟目录" 204 "$(acode -X DELETE "$WOTHER")"

printf '\n\033[1m结果: %d 通过, %d 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
# 已在后面追加：见下方分隔（实际追加在清理段之前，直接改文件）
