#!/usr/bin/env bash
# FlareDrive WebDAV / API 冒烟测试
#
# 用法:
#   scripts/smoke-test.sh [base-url]
#
# 默认对 http://127.0.0.1:8788 执行，需要本地 wrangler 使用仓库里给出的
# 测试账号（见文档「本地开发」一节）。所有增删改操作都发生在 `_smoke`
# 目录内，脚本开始与结束都会把它清掉，可以反复执行。
set -uo pipefail

BASE="${1:-http://127.0.0.1:8788}"
ADMIN="admin:secret"
USER1="user1:pass1"
USER2="user2:pass2"
PASS=0
FAIL=0

ROOT_NAME="_smoke"
W="$BASE/webdav/$ROOT_NAME"      # WebDAV 测试根
R="$BASE/raw/$ROOT_NAME"         # raw 直链测试根
L="$BASE/api/list/$ROOT_NAME"    # JSON 列举测试根
Z="$BASE/api/zip/$ROOT_NAME"     # 打包下载测试根

ok()   { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s (期望 %s, 实际 %s)\n' "$1" "$2" "$3"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }
atleast(){ if [ "${3:-0}" -ge "$2" ]; then ok "$1"; else bad "$1" ">=$2" "$3"; fi; }
atmost(){ if [ "${3:-0}" -le "$2" ]; then ok "$1"; else bad "$1" "<=$2" "$3"; fi; }

code()  { curl -s -o /dev/null -w '%{http_code}' "$@"; }
acode() { curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN" "$@"; }
hdr()   { curl -s -D- -o /dev/null "$@" | tr -d '\r'; }
section(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

LOCKBODY='<?xml version="1.0" encoding="utf-8"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>smoke-test</D:href></D:owner></D:lockinfo>'
PPBODY='<?xml version="1.0" encoding="utf-8"?><D:propertyupdate xmlns:D="DAV:"><D:set><D:prop><Z:Win32FileAttributes xmlns:Z="urn:schemas-microsoft-com:">00000020</Z:Win32FileAttributes></D:prop></D:set></D:propertyupdate>'

# 清理上次残留
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$W"
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$BASE/webdav/_smoke-key"

section "1. OPTIONS 与服务发现"
check "OPTIONS 返回 200" 200 "$(code -X OPTIONS "$BASE/webdav/")"
DAVHDR="$(hdr -X OPTIONS "$BASE/webdav/" | grep -i '^dav:' | head -1)"
case "$DAVHDR" in *"1, 2"*) ok "DAV 宣告 class 1,2 ($DAVHDR)";; *) bad "DAV 宣告 class 1,2" "DAV: 1, 2" "$DAVHDR";; esac
ALLOWHDR="$(hdr -X OPTIONS "$BASE/webdav/" | grep -i '^allow:' | head -1)"
case "$ALLOWHDR" in *PROPFIND*LOCK*UNLOCK*) ok "Allow 含 PROPFIND/LOCK/UNLOCK";; *) bad "Allow 头" "含 PROPFIND/LOCK/UNLOCK" "$ALLOWHDR";; esac
check "MS-Author-Via 头存在" 1 "$(hdr -X OPTIONS "$BASE/webdav/" | grep -ci '^ms-author-via: DAV')"

section "2. 匿名读取（公开读开启）"
check "PROPFIND 根目录匿名 207" 207 "$(code -X PROPFIND -H 'Depth: 1' "$BASE/webdav/")"
check "错误密码 401" 401 "$(code -X PROPFIND -H 'Authorization: Basic YWRtaW46d3Jvbmc=' "$BASE/webdav/")"
check "非法 Authorization 头 401" 401 "$(code -X PROPFIND -H 'Authorization: Bearer xyz' "$BASE/webdav/")"

section "3. 目录与文件基础操作（admin）"
check "MKCOL 建目录 201" 201 "$(acode -X MKCOL "$W/docs")"
check "MKCOL 重复 405" 405 "$(acode -X MKCOL "$W/docs")"
check "PUT 上传 201" 201 "$(acode -X PUT --data-binary 'hello world' -H 'Content-Type: text/plain' "$W/docs/hello.txt")"
check "MKCOL 到已存在文件 405" 405 "$(acode -X MKCOL "$W/docs/hello.txt")"
check "PUT 到已存在目录 405" 405 "$(acode -X PUT --data 'x' "$W/docs")"
check "GET 内容一致" "hello world" "$(curl -s "$W/docs/hello.txt")"
check "raw 直链内容一致" "hello world" "$(curl -s "$R/docs/hello.txt")"
check "HEAD 200" 200 "$(code -I "$W/docs/hello.txt")"
check "HEAD 带 Content-Length" 11 "$(hdr -I "$W/docs/hello.txt" | grep -i '^content-length:' | tr -dc '0-9')"
check "父目录不存在时 PUT 自动建目录 201" 201 "$(acode -X PUT --data 'x' "$W/docs/sub/deep.txt")"
check "GET 深层文件" "x" "$(curl -s "$W/docs/sub/deep.txt")"
check "PUT 空内容 201" 201 "$(acode -X PUT --data '' "$W/docs/empty.txt")"
check "GET 空内容长度 0" 0 "$(curl -s "$W/docs/empty.txt" | wc -c | tr -d ' ')"

section "4. Range 与条件请求"
check "Range 206" 206 "$(code -H 'Range: bytes=0-4' "$W/docs/hello.txt")"
check "Range 内容正确" "hello" "$(curl -s -H 'Range: bytes=0-4' "$W/docs/hello.txt")"
CRANGE="$(hdr -H 'Range: bytes=0-4' "$W/docs/hello.txt" | grep -i '^content-range:' | head -1)"
case "$CRANGE" in *"bytes 0-4/11"*) ok "Content-Range 正确";; *) bad "Content-Range" "bytes 0-4/11" "$CRANGE";; esac
check "后缀 Range 206" 206 "$(code -H 'Range: bytes=-5' "$W/docs/hello.txt")"
check "后缀 Range 内容正确" "world" "$(curl -s -H 'Range: bytes=-5' "$W/docs/hello.txt")"
check "非法 Range 416" 416 "$(code -H 'Range: bytes=99-200' "$W/docs/hello.txt")"
ETAG="$(hdr "$W/docs/hello.txt" | grep -i '^etag:' | head -1 | cut -d' ' -f2)"
check "ETag 存在" 1 "$(printf '%s' "$ETAG" | grep -c '"')"
check "If-None-Match 命中 304" 304 "$(code -H "If-None-Match: $ETAG" "$W/docs/hello.txt")"
check "If-Match 不匹配 412" 412 "$(code -H 'If-Match: "deadbeef"' "$W/docs/hello.txt")"
check "Accept-Ranges 头" 1 "$(hdr "$W/docs/hello.txt" | grep -ci '^accept-ranges: bytes')"

section "5. PROPFIND 细节"
PF="$(curl -s -X PROPFIND -H 'Depth: 1' "$W/docs/")"
case "$PF" in *"<D:multistatus"*) ok "返回 XML multistatus";; *) bad "返回 XML" "<D:multistatus" "$(printf '%s' "$PF" | head -c 60)";; esac
atleast "列出子文件" 1 "$(printf '%s' "$PF" | grep -c 'hello.txt')"
atleast "目录标记 resourcetype" 1 "$(printf '%s' "$PF" | grep -c '<D:collection />')"
atleast "宣告 supportedlock" 1 "$(printf '%s' "$PF" | grep -c 'supportedlock')"
atleast "含 getcontentlength" 1 "$(printf '%s' "$PF" | grep -c 'getcontentlength')"
atleast "含 getetag" 1 "$(printf '%s' "$PF" | grep -c 'getetag')"
atleast "含 quota-available-bytes" 1 "$(printf '%s' "$PF" | grep -c 'quota-available-bytes')"
PFD0="$(curl -s -X PROPFIND -H 'Depth: 0' "$W/docs/")"
atmost "Depth:0 不列出子项" 0 "$(printf '%s' "$PFD0" | grep -c 'hello.txt')"
PFINF="$(curl -s -X PROPFIND -H 'Depth: infinity' "$W/docs/")"
atleast "Depth:infinity 递归含深层文件" 1 "$(printf '%s' "$PFINF" | grep -c 'deep.txt')"
atleast "Depth:infinity 合成中间目录" 1 "$(printf '%s' "$PFINF" | grep -c 'sub/')"
PROPNAME="$(curl -s -X PROPFIND -H 'Depth: 0' --data-binary '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>' "$W/docs/hello.txt")"
atleast "propname 模式有属性名" 1 "$(printf '%s' "$PROPNAME" | grep -c 'getcontentlength />')"
PFSEL="$(curl -s -X PROPFIND -H 'Depth: 0' --data-binary '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:getcontentlength/></D:prop></D:propfind>' "$W/docs/hello.txt")"
atleast "指定属性请求可用" 1 "$(printf '%s' "$PFSEL" | grep -c 'getcontentlength')"

section "6. COPY / MOVE"
check "COPY 201" 201 "$(acode -X COPY -H "Destination: $W/docs/copy.txt" "$W/docs/hello.txt")"
check "COPY 结果内容一致" "hello world" "$(curl -s "$W/docs/copy.txt")"
check "COPY 目标存在且 Overwrite:F → 412" 412 "$(acode -X COPY -H "Destination: $W/docs/copy.txt" -H 'Overwrite: F' "$W/docs/hello.txt")"
check "COPY Overwrite:T 覆盖 204" 204 "$(acode -X COPY -H "Destination: $W/docs/copy.txt" -H 'Overwrite: T' "$W/docs/hello.txt")"
check "MOVE 201" 201 "$(acode -X MOVE -H "Destination: $W/docs/moved.txt" "$W/docs/copy.txt")"
check "MOVE 后源消失 404" 404 "$(code "$W/docs/copy.txt")"
check "MOVE 结果存在" "hello world" "$(curl -s "$W/docs/moved.txt")"
check "COPY 到站外 Destination 400" 400 "$(acode -X COPY -H 'Destination: https://evil.example/webdav/x' "$W/docs/hello.txt")"
check "COPY 缺少 Destination 400" 400 "$(acode -X COPY "$W/docs/hello.txt")"
check "COPY 到自身子目录 400" 400 "$(acode -X COPY -H "Destination: $W/docs/sub/inner" "$W/docs")"
check "目录递归 COPY 201" 201 "$(acode -X COPY -H "Destination: $W/docs-full" "$W/docs")"
check "递归 COPY 含深层文件" 200 "$(code "$W/docs-full/sub/deep.txt")"
check "目录 COPY Depth:0 只建目录 201" 201 "$(acode -X COPY -H "Destination: $W/docs-shallow" -H 'Depth: 0' "$W/docs")"
check "Depth:0 不含子文件 404" 404 "$(code "$W/docs-shallow/hello.txt")"
check "目录 MOVE Depth:0 → 400" 400 "$(acode -X MOVE -H "Destination: $W/docs-elsewhere" -H 'Depth: 0' "$W/docs-full")"
check "目录 MOVE 201" 201 "$(acode -X MOVE -H "Destination: $W/docs-moved" "$W/docs-full")"
check "目录 MOVE 后源消失" 404 "$(code "$W/docs-full/sub/deep.txt")"
check "目录 MOVE 后目标存在" 200 "$(code "$W/docs-moved/sub/deep.txt")"

section "7. LOCK / UNLOCK（DAV class 2）"
LOCKHDR="$(curl -s -D- -o /tmp/lockbody.xml -u "$ADMIN" -X LOCK -H 'Timeout: Second-600' -H 'Depth: 0' --data-binary "$LOCKBODY" "$W/docs/hello.txt" | tr -d '\r')"
TOKEN="$(printf '%s' "$LOCKHDR" | grep -i '^lock-token:' | head -1 | sed 's/^[Ll]ock-[Tt]oken: *//' | tr -d '<>')"
atleast "LOCK 返回 Lock-Token" 1 "$(printf '%s' "$TOKEN" | grep -c 'opaquelocktoken:')"
case "$(cat /tmp/lockbody.xml)" in *lockdiscovery*) ok "LOCK 响应体含 lockdiscovery";; *) bad "LOCK 响应体" "lockdiscovery" "缺失";; esac
atleast "LOCK 回显 owner" 1 "$(cat /tmp/lockbody.xml | grep -c 'smoke-test')"
check "加锁后无令牌 PUT → 423" 423 "$(acode -X PUT --data 'blocked' "$W/docs/hello.txt")"
check "加锁后无令牌 DELETE → 423" 423 "$(acode -X DELETE "$W/docs/hello.txt")"
check "加锁后无令牌 MKCOL → 423" 423 "$(acode -X MKCOL "$W/docs/hello.txt")"
check "带 If 令牌 PUT → 201" 201 "$(acode -X PUT -H "If: (<$TOKEN>)" --data 'locked-write' "$W/docs/hello.txt")"
atleast "PROPFIND 显示 lockdiscovery" 1 "$(curl -s -X PROPFIND -H 'Depth: 0' "$W/docs/hello.txt" | grep -c 'activelock')"
check "LOCK 续期 200" 200 "$(acode -X LOCK -H "If: (<$TOKEN>)" -H 'Timeout: Second-1200' --data-binary "$LOCKBODY" "$W/docs/hello.txt")"
check "重复 LOCK 无令牌 423" 423 "$(acode -X LOCK -H 'Depth: 0' --data-binary "$LOCKBODY" "$W/docs/hello.txt")"
check "UNLOCK 204" 204 "$(acode -X UNLOCK -H "Lock-Token: <$TOKEN>" "$W/docs/hello.txt")"
check "解锁后 PUT 恢复 201" 201 "$(acode -X PUT --data 'after-unlock' "$W/docs/hello.txt")"
check "UNLOCK 无锁 409" 409 "$(acode -X UNLOCK -H "Lock-Token: <$TOKEN>" "$W/docs/hello.txt")"
check "UNLOCK 缺令牌 400" 400 "$(acode -X UNLOCK "$W/docs/hello.txt")"
# 目录锁对子孙生效
acode -X MKCOL "$W/lockdir" >/dev/null
DIRLOCK="$(curl -s -D- -o /dev/null -u "$ADMIN" -X LOCK -H 'Depth: infinity' -H 'Timeout: Second-600' --data-binary "$LOCKBODY" "$W/lockdir" | tr -d '\r')"
DTOKEN="$(printf '%s' "$DIRLOCK" | grep -i '^lock-token:' | head -1 | sed 's/^[Ll]ock-[Tt]oken: *//' | tr -d '<>')"
check "目录锁拦住子孙写入 423" 423 "$(acode -X PUT --data 'x' "$W/lockdir/child.txt")"
check "目录锁带令牌可写 201" 201 "$(acode -X PUT -H "If: (<$DTOKEN>)" --data 'x' "$W/lockdir/child.txt")"
check "释放目录锁 204" 204 "$(acode -X UNLOCK -H "Lock-Token: <$DTOKEN>" "$W/lockdir")"

section "8. PROPPATCH"
check "PROPPATCH 207" 207 "$(acode -X PROPPATCH --data-binary "$PPBODY" "$W/docs/hello.txt")"
atleast "PROPPATCH 回显属性名" 1 "$(curl -s -u "$ADMIN" -X PROPPATCH --data-binary "$PPBODY" "$W/docs/hello.txt" | grep -c 'Win32FileAttributes')"

section "9. 旧版目录标记兼容"
check "写入旧标记 legacy/_\$folder\$ 201" 201 "$(acode -X PUT --data '' "$W/legacy/_\$folder\$")"
check "旧标记目录在 PROPFIND 中为集合" 1 "$(curl -s -X PROPFIND -H 'Depth: 1' "$W/" | grep -c "legacy/</D:href>")"
check "api/list 把旧标记当文件夹" 1 "$(curl -s "$L/" | grep -c '"name":"legacy"')"
check "旧标记目录内可写文件" 201 "$(acode -X PUT --data 'in-legacy' "$W/legacy/inside.txt")"
check "读取旧标记目录内文件" "in-legacy" "$(curl -s "$W/legacy/inside.txt")"
check "COPY 旧目录迁移标记 201" 201 "$(acode -X COPY -H "Destination: $W/legacy-copy" "$W/legacy")"
check "迁移后变成目录对象（MKCOL 冲突 405）" 405 "$(acode -X MKCOL "$W/legacy-copy")"
check "迁移后旧标记已由目录对象承载" 200 "$(code "$W/legacy-copy/inside.txt")"

section "10. 多账号与分目录权限"
check "user1 写入自己的目录 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" -X PUT --data 'u1' "$BASE/webdav/user1/a.txt")"
check "user1 写入未授权目录 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" -X PUT --data 'x' "$BASE/webdav/secret/x.txt")"
check "user1 读取未授权目录 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" "$R/docs/hello.txt")"
check "user1 列根目录看不到 _smoke" 0 "$(curl -s -u "$USER1" -X PROPFIND -H 'Depth: 1' "$BASE/webdav/" | grep -c "$ROOT_NAME/")"
check "user1 列根目录可见 user1/" 1 "$(curl -s -u "$USER1" -X PROPFIND -H 'Depth: 1' "$BASE/webdav/" | grep -c 'user1/')"
check "user1 删未授权路径 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" -X DELETE "$BASE/webdav/secret/x.txt")"
check "错误密码 401" 401 "$(code -u 'user1:wrong' -X PUT --data 'x' "$BASE/webdav/user1/z.txt")"
check "匿名写 GUEST 目录 201" 201 "$(code -X PUT --data 'guest' "$BASE/webdav/public/g.txt")"
check "匿名读 GUEST 目录" "guest" "$(curl -s "$BASE/webdav/public/g.txt")"
check "匿名写非 GUEST 目录 401" 401 "$(code -X PUT --data 'x' "$BASE/webdav/elsewhere.txt")"
check "匿名可删 GUEST 目录内文件（与旧版语义一致）204" 204 "$(code -X DELETE "$BASE/webdav/public/g.txt")"
check "admin 删文件 204" 204 "$(acode -X DELETE "$W/docs/moved.txt")"
check "user2 通配权限可读 200" 200 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER2" "$R/docs/hello.txt")"
check "user2 通配权限可写 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER2" -X PUT --data 'u2' "$W/user2.txt")"

section "11. 特殊字符与转义"
check "含空格与 & 的文件名 201" 201 "$(acode -X PUT --data 'special' "$W/docs/a%20b%20%26%20c.txt")"
check "GET 该文件内容一致" "special" "$(curl -s "$W/docs/a%20b%20%26%20c.txt")"
check "中文文件名 201" 201 "$(acode -X PUT --data 'cn' "$W/docs/%E4%B8%AD%E6%96%87.txt")"
check "GET 中文文件内容一致" "cn" "$(curl -s "$W/docs/%E4%B8%AD%E6%96%87.txt")"
atmost "XML 中不出现裸 &" 0 "$(curl -s -X PROPFIND -H 'Depth: 1' "$W/docs/" | grep -c 'b & c')"
atleast "XML 中 & 已转义为 &amp;" 1 "$(curl -s -X PROPFIND -H 'Depth: 1' "$W/docs/" | grep -c 'b &amp; c')"
atleast "XML 合法可解析（首行声明）" 1 "$(curl -s -X PROPFIND -H 'Depth: 1' "$W/docs/" | head -1 | grep -c '<?xml')"
check "带 & 文件可删除 204" 204 "$(acode -X DELETE "$W/docs/a%20b%20%26%20c.txt")"

section "12. 内部保留目录保护"
check "根目录 PROPFIND 不含内部目录条目" 0 "$(curl -s -X PROPFIND -H 'Depth: 1' "$BASE/webdav/" | grep -cF '<D:href>/webdav/_$flaredrive$')"
check "写入内部目录被拒 403" 403 "$(acode -X PUT --data 'x' "$BASE/webdav/_%24flaredrive%24/evil.txt")"
check "删除内部目录被拒 403" 403 "$(acode -X DELETE "$BASE/webdav/_%24flaredrive%24")"
check "缩略图可写 201" 201 "$(acode -X PUT --data 'png' -H 'Content-Type: image/png' "$BASE/webdav/_%24flaredrive%24/thumbnails/abc123.png")"
check "缩略图匿名可读" "png" "$(curl -s "$BASE/raw/_%24flaredrive%24/thumbnails/abc123.png")"
check "缩略图长缓存" 1 "$(hdr "$BASE/raw/_%24flaredrive%24/thumbnails/abc123.png" | grep -ci 'max-age=31536000')"
check "api/list 不含内部目录条目" 0 "$(curl -s "$BASE/api/list/" | grep -cF '"key":"_$flaredrive$')"
check "匿名读内部对象 404" 404 "$(code "$BASE/raw/_%24flaredrive%24/locks/whatever.json")"
check "匿名 PROPFIND 内部目录 404" 404 "$(code -X PROPFIND -H 'Depth: 0' "$BASE/webdav/_%24flaredrive%24")"
check "api/list 内部目录 404" 404 "$(acode "$BASE/api/list/_%24flaredrive%24")"

section "13. JSON 接口与打包下载"
check "whoami 200" 200 "$(code "$BASE/api/whoami")"
check "whoami 匿名 publicRead=true" "true" "$(curl -s "$BASE/api/whoami" | grep -o '"publicRead":[a-z]*' | cut -d: -f2)"
check "whoami admin 已认证" "admin" "$(curl -s -u "$ADMIN" "$BASE/api/whoami" | grep -o '"username":"[^"]*"' | cut -d: -f2 | tr -d '"')"
check "whoami 含 maxUploadSize" 1 "$(curl -s "$BASE/api/whoami" | grep -c 'maxUploadSize')"
check "api/list 200" 200 "$(acode "$L/")"
check "api/list 含 canWrite" 1 "$(curl -s -u "$ADMIN" "$L/docs" | grep -c '"canWrite":true')"
check "api/list 含 thumbnail 字段" 1 "$(curl -s -u "$ADMIN" "$L/docs" | grep -c '"thumbnail"')"
check "api/list 不存在 404" 404 "$(acode "$L/nope")"
check "api/list 指向文件 404" 404 "$(acode "$L/docs/hello.txt")"
check "api/zip 200" 200 "$(acode "$Z/docs")"
curl -s -u "$ADMIN" "$Z/docs" -o /tmp/smoke-docs.zip
check "zip 魔数 PK" "PK" "$(head -c 2 /tmp/smoke-docs.zip)"
if command -v unzip >/dev/null 2>&1; then
  check "zip 内含 hello.txt" 1 "$(unzip -l /tmp/smoke-docs.zip 2>/dev/null | grep -c 'hello.txt')"
  check "zip 内含深层文件" 1 "$(unzip -l /tmp/smoke-docs.zip 2>/dev/null | grep -c 'sub/deep.txt')"
  check "zip 内目录条目带斜杠" 1 "$(unzip -l /tmp/smoke-docs.zip 2>/dev/null | grep -cE '(^| )sub/$')"
  check "zip 不含旧标记文件" 0 "$(unzip -l /tmp/smoke-docs.zip 2>/dev/null | grep -c '_\$folder\$')"
else
  printf '  \033[33mskip\033[0m unzip 不可用，跳过 zip 内容校验\n'
fi
check "zip 匿名可达（公开读）" 200 "$(code "$Z/docs")"
check "zip 单文件 200" 200 "$(acode "$Z/docs/hello.txt")"
check "raw 强制下载头" 1 "$(hdr "$R/docs/hello.txt?download=1" | grep -ci '^content-disposition: attachment')"
check "raw 目录 404" 404 "$(code "$R/docs")"

section "14. 删除语义"
check "DELETE 目录 204" 204 "$(acode -X DELETE "$W/docs-moved")"
check "递归删除生效 404" 404 "$(code "$W/docs-moved/sub/deep.txt")"
check "DELETE 不存在 404" 404 "$(acode -X DELETE "$W/nope")"
check "DELETE 根目录 403" 403 "$(acode -X DELETE "$BASE/webdav/")"
check "清理测试目录 204" 204 "$(acode -X DELETE "$W")"
check "清理后测试根 404" 404 "$(code -X PROPFIND -H 'Depth: 0' "$W")"

section "15. API Key 与上传接口"
check "匿名列密钥 401" 401 "$(code "$BASE/api/keys")"
check "非管理员列密钥 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" "$BASE/api/keys")"
check "admin 列密钥 200" 200 "$(acode "$BASE/api/keys")"
check "缺少 name 创建失败 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/api/keys")"
KEYRESP="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"name":"smoke","permissions":"_smoke-key/,public/"}' "$BASE/api/keys")"
AKEY="$(printf '%s' "$KEYRESP" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)"
AID="$(printf '%s' "$KEYRESP" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)"
atleast "创建密钥返回明文 key" 1 "$(printf '%s' "$AKEY" | grep -c '^fd_')"
atleast "创建响应含 id" 1 "$(printf '%s' "$AID" | grep -cE '^[0-9a-f]{10}$')"
check "密钥列表不泄漏摘要" 0 "$(curl -s -u "$ADMIN" "$BASE/api/keys" | grep -c '"hash"')"
check "X-Api-Key 上传授权路径 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-Api-Key: $AKEY" --data 'k' "$BASE/webdav/_smoke-key/a.txt")"
check "Bearer 上传 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $AKEY" --data 'k' "$BASE/webdav/_smoke-key/b.txt")"
check "Basic 密码位填 key 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -u "apikey:$AKEY" -X PUT --data 'k' "$BASE/webdav/_smoke-key/c.txt")"
check "密钥读回内容" "k" "$(curl -s -H "X-Api-Key: $AKEY" "$BASE/raw/_smoke-key/a.txt")"
check "密钥越权 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-Api-Key: $AKEY" --data 'x' "$BASE/webdav/docs/evil-key.txt")"
check "伪造的密钥 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: fd_0000000000_00000000000000000000000000000000" "$BASE/api/list/")"
check "密钥不能管理密钥 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $AKEY" "$BASE/api/keys")"
check "whoami 标记 viaApiKey" 1 "$(curl -s -H "X-Api-Key: $AKEY" "$BASE/api/whoami" | grep -c '"viaApiKey":true')"
printf 'api upload body\n' > /tmp/smoke-upload.txt
check "multipart 上传 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Api-Key: $AKEY" -F "file=@/tmp/smoke-upload.txt" "$BASE/api/upload/_smoke-key/")"
check "multipart 上传内容正确" "api upload body" "$(curl -s "$BASE/raw/_smoke-key/smoke-upload.txt")"
check "原始字节流 PUT 上传 201" 201 "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "X-Api-Key: $AKEY" -H 'Content-Type: application/octet-stream' --data-binary 'raw' "$BASE/api/upload/_smoke-key/raw.bin")"
check "上传接口缺文件字段 400" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-Api-Key: $AKEY" -F "note=hi" "$BASE/api/upload/_smoke-key/")"
check "上传接口匿名写入非 GUEST 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -F "file=@/tmp/smoke-upload.txt" "$BASE/api/upload/_smoke/")"
check "吊销密钥 204" 204 "$(curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN" -X DELETE "$BASE/api/keys/$AID")"
check "吊销后失效 401" 401 "$(curl -s -o /dev/null -w '%{http_code}' -H "X-Api-Key: $AKEY" "$BASE/api/list/")"
check "吊销不存在的密钥 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -u "$ADMIN" -X DELETE "$BASE/api/keys/0000000000")"
check "清理密钥测试目录 204" 204 "$(acode -X DELETE "$BASE/webdav/_smoke-key")"

printf '\n\033[1m结果: %d 通过, %d 失败\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
