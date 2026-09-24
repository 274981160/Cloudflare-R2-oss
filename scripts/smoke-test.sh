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
# 删除现在会进回收站，残留会挡住同名重建 → 顺手清空回收站，保证脚本可反复执行
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$BASE/api/trash"
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
case "$PF" in *"<multistatus"*) ok "返回 XML multistatus";; *) bad "返回 XML" "<multistatus" "$(printf '%s' "$PF" | head -c 60)";; esac
atleast "列出子文件" 1 "$(printf '%s' "$PF" | grep -c 'hello.txt')"
atleast "目录标记 resourcetype" 1 "$(printf '%s' "$PF" | grep -c '<collection />')"
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
check "旧标记目录在 PROPFIND 中为集合" 1 "$(curl -s -X PROPFIND -H 'Depth: 1' "$W/" | grep -c "legacy/</href>")"
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
check "根目录 PROPFIND 不含内部目录条目" 0 "$(curl -s -X PROPFIND -H 'Depth: 1' "$BASE/webdav/" | grep -cF '<href>/webdav/_$flaredrive$')"
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

section "13.5 在线解压 / 压缩"
rm -rf /tmp/smoke-zipdir && mkdir -p /tmp/smoke-zipdir/tree/sub
printf 'unzip-online' > /tmp/smoke-zipdir/tree/alpha.txt
printf 'nested-deep' > /tmp/smoke-zipdir/tree/sub/beta.txt
(cd /tmp/smoke-zipdir && rm -f ../smoke-online.zip && zip -q -r ../smoke-online.zip tree)
check "创建 zip 夹具 201" 201 "$(acode -X PUT --data-binary @/tmp/smoke-online.zip -H 'Content-Type: application/zip' "$W/online.zip")"
check "解压 zip 200" 200 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/online-out"}' "$BASE/api/unzip/_smoke/online.zip")"
check "解压后文件存在 200" 200 "$(code "$W/online-out/tree/alpha.txt")"
check "解压内容一致" "unzip-online" "$(curl -s "$W/online-out/tree/alpha.txt")"
check "解压嵌套子目录文件 200" 200 "$(code "$W/online-out/tree/sub/beta.txt")"
check "解压嵌套内容一致" "nested-deep" "$(curl -s "$W/online-out/tree/sub/beta.txt")"
check "解压路径穿越被拒 400" 400 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"../_smoke"}' "$BASE/api/unzip/_smoke/online.zip")"
# 同名文件保护：默认跳过，绝不静默覆盖用户已有文件
CONFLICTS="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/online-out","mode":"check"}' "$BASE/api/unzip/_smoke/online.zip" | grep -o '"conflictCount":[0-9]*' | cut -d: -f2)"
atleast "解压预检报告同名冲突" 2 "${CONFLICTS:-0}"
check "预检不改动目标" "unzip-online" "$(curl -s "$W/online-out/tree/alpha.txt")"
check "改写目标文件 201" 201 "$(acode -X PUT --data 'user-edited' "$W/online-out/tree/alpha.txt")"
check "默认解压（跳过同名）200" 200 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/online-out"}' "$BASE/api/unzip/_smoke/online.zip")"
check "跳过模式保住用户改动" "user-edited" "$(curl -s "$W/online-out/tree/alpha.txt")"
check "覆盖模式 200" 200 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/online-out","mode":"overwrite"}' "$BASE/api/unzip/_smoke/online.zip")"
check "覆盖模式写入包内内容" "unzip-online" "$(curl -s "$W/online-out/tree/alpha.txt")"
check "解压到内部目录被拒 403" 403 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_$flaredrive$/x"}' "$BASE/api/unzip/_smoke/online.zip")"
check "压缩为 zip 200" 200 "$(acode -X POST -H 'Content-Type: application/json' -d '{"sources":["_smoke/online-out/tree","_smoke/online.zip"]}' "$BASE/api/compress/_smoke/made.zip")"
check "压缩产物存在 200" 200 "$(code "$W/made.zip")"
curl -s -u "$ADMIN" "$R/made.zip" -o /tmp/smoke-made.zip
check "压缩产物是合法 zip" "PK" "$(head -c 2 /tmp/smoke-made.zip)"
if command -v unzip >/dev/null 2>&1; then
  atleast "压缩产物含原文件名" 1 "$(unzip -l /tmp/smoke-made.zip 2>/dev/null | grep -c 'alpha.txt')"
  check "压缩产物不含外部文件" 0 "$(unzip -l /tmp/smoke-made.zip 2>/dev/null | grep -c 'docs/hello.txt')"
fi
check "压缩来源越权被拒 403" 403 "$(curl -s -o /dev/null -w '%{http_code}' -u "$USER1" -X POST -H 'Content-Type: application/json' -d '{"sources":["_smoke/online.zip"]}' "$BASE/api/compress/_smoke/user1-forbidden.zip")"
check "解压 zip 不存在 404" 404 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/out"}' "$BASE/api/unzip/_smoke/nope.zip")"
check "解压非 zip 400" 400 "$(acode -X POST -H 'Content-Type: application/json' -d '{"target":"_smoke/out"}' "$BASE/api/unzip/_smoke/docs/hello.txt")"

section "13.6 回收站（软删除）"
TR="$W/trash-target"
check "建回收站测试目录 201" 201 "$(acode -X MKCOL "$TR")"
check "写入待删文件 201" 201 "$(acode -X PUT --data 'precious data' "$TR/keep.txt")"
check "删除返回 204" 204 "$(acode -X DELETE "$TR")"
check "删除后列表里消失 404" 404 "$(code "$BASE/api/list/_smoke/trash-target")"
check "删除后直链 404" 404 "$(code "$W/trash-target/keep.txt")"
check "删除后 PROPFIND 404" 404 "$(code -X PROPFIND -H 'Depth: 0' "$W/trash-target")"
TRASHJSON="$(curl -s -u "$ADMIN" "$BASE/api/trash")"
TRASHID="$(printf '%s' "$TRASHJSON" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_smoke/trash-target']
print(hit[0] if hit else '')" 2>/dev/null)"
atleast "回收站里能查到" 1 "$(printf '%s' "$TRASHID" | grep -c .)"
atleast "回收站带原路径与大小" 1 "$(printf '%s' "$TRASHJSON" | grep -c '"_smoke/trash-target"')"
# 往已删除的文件夹里写子文件是允许的（同名文件夹里解压就靠这条路径）：
# 新写入的对象正常可见，旧内容仍被隐藏，互不影响
check "回收站子树内写入 201" 201 "$(acode -X PUT --data 'x' "$W/trash-target/new.txt")"
check "新写入的可见" "x" "$(curl -s "$W/trash-target/new.txt")"
check "旧内容仍隐藏 404" 404 "$(code "$W/trash-target/keep.txt")"
check "恢复 200" 200 "$(acode -X POST "$BASE/api/trash/$TRASHID/restore")"
check "恢复后新旧内容都在" "precious data" "$(curl -s "$W/trash-target/keep.txt")"
check "恢复后新写入的也在" "x" "$(curl -s "$W/trash-target/new.txt")"
check "恢复后内容完好" "precious data" "$(curl -s "$W/trash-target/keep.txt")"
check "恢复后回收站不再有它" 0 "$(curl -s -u "$ADMIN" "$BASE/api/trash" | grep -c '"_smoke/trash-target"')"
check "再次删除 204" 204 "$(acode -X DELETE "$TR")"
TRASHID2="$(curl -s -u "$ADMIN" "$BASE/api/trash" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_smoke/trash-target']
print(hit[0] if hit else '')" 2>/dev/null)"
check "彻底删除 200" 200 "$(acode -X DELETE "$BASE/api/trash/$TRASHID2")"
check "彻底删除后该路径可重新写入 201" 201 "$(acode -X PUT --data 'new' "$W/trash-target")"
check "彻底删除后直链是新内容" "new" "$(curl -s "$W/trash-target")"
check "回收站不存在的项 404" 404 "$(acode -X DELETE "$BASE/api/trash/nope-不存在")"
check "恢复不存在的项 404" 404 "$(acode -X POST "$BASE/api/trash/nope-不存在/restore")"
check "匿名读回收站 401" 401 "$(code "$BASE/api/trash")"
check "回收站不能被直接分享 403" 403 "$(acode -X POST -H 'Content-Type: application/json' -d '{"key":"_$flaredrive$/trash"}' "$BASE/api/shares")"
check "清理回收站测试残留 204" 204 "$(acode -X DELETE "$W/trash-target")"

section "13.7 覆盖保护（旧文件进回收站）"
OV="$W/overwrite"
check "建覆盖测试目录 201" 201 "$(acode -X MKCOL "$OV")"
check "写入旧版本 201" 201 "$(acode -X PUT --data 'version-1' "$OV/doc.txt")"
check "同名覆盖写入 201" 201 "$(acode -X PUT --data 'version-2' "$OV/doc.txt")"
check "覆盖后内容是新版本" "version-2" "$(curl -s "$W/overwrite/doc.txt")"
OVTRASH="$(curl -s -u "$ADMIN" "$BASE/api/trash")"
atleast "被覆盖的旧版本进了回收站" 1 "$(printf '%s' "$OVTRASH" | grep -c '"_smoke/overwrite/doc.txt"')"
check "覆盖不影响该路径可见性" "doc.txt" "$(curl -s -u "$ADMIN" "$BASE/api/list/_smoke/overwrite" | python3 -c "
import json,sys
print(','.join(f['name'] for f in json.load(sys.stdin)['files']))")"
OVID="$(printf '%s' "$OVTRASH" | python3 -c "
import json,sys
items=json.load(sys.stdin)['items']
hit=[i['id'] for i in items if i['key']=='_smoke/overwrite/doc.txt']
print(hit[0] if hit else '')" 2>/dev/null)"
check "恢复旧版本 200" 200 "$(acode -X POST "$BASE/api/trash/$OVID/restore")"
check "旧版本改名保留（原路径已被新文件占用）" "version-1" "$(curl -s "$W/overwrite/doc.txt%20(%E6%81%A2%E5%A4%8D)")"
check "新版本仍在" "version-2" "$(curl -s "$W/overwrite/doc.txt")"
check "清理覆盖测试目录 204" 204 "$(acode -X DELETE "$OV")"

section "13.8 同名预检 /api/exists"
check "建预检探针文件 201" 201 "$(acode -X PUT --data 'probe' "$W/exists-probe.txt")"
check "预检已存在 200" 200 "$(acode -X POST -H 'Content-Type: application/json' -d '{"keys":["_smoke/exists-probe.txt"]}' "$BASE/api/exists")"
atleast "预检结果含已存在的 key" 1 "$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"keys":["_smoke/exists-probe.txt"]}' "$BASE/api/exists" | grep -c 'exists-probe')"
check "预检不存在的返回空" "[]" "$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"keys":["_smoke/no-such-file-xyz"]}' "$BASE/api/exists" | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['existing']))")"
check "预检空 keys 400" 400 "$(acode -X POST -H 'Content-Type: application/json' -d '{"keys":[]}' "$BASE/api/exists")"
check "预检非 JSON 400" 400 "$(acode -X POST -H 'Content-Type: application/json' -d 'nope' "$BASE/api/exists")"
check "匿名预检 401" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{"keys":["_smoke/a.txt"]}' "$BASE/api/exists")"

section "13.9 预览直链：流式与 Range（大图/视频不用等整包）"
check "建 Range 测试文件 201" 201 "$(acode -X PUT --data '0123456789abcdefghijklmnopqrstuvwxyz' "$W/range.bin")"
check "签名接口 200" 200 "$(acode "$BASE/api/sign?key=_smoke/range.bin")"
SIGNURL="$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_smoke/range.bin" | python3 -c "
import json,sys
print(json.load(sys.stdin)['url'])" 2>/dev/null)"
atleast "签名直链可匿名访问（预览要靠它）" 1 "$([ "$(code "$BASE$SIGNURL")" = "200" ] && echo 1 || echo 0)"
check "直链支持 Range（视频拖进度）206" 206 "$(code -H 'Range: bytes=0-3' "$BASE$SIGNURL")"
check "Range 响应带 Content-Range" 1 "$(curl -s -D- -o /dev/null -H 'Range: bytes=0-3' "$BASE$SIGNURL" | grep -ci 'content-range: bytes 0-3/')"
check "整文件响应声明 Accept-Ranges" 1 "$(curl -s -D- -o /dev/null "$BASE$SIGNURL" | grep -ci 'accept-ranges: bytes')"
check "过短 ttl 被抬到 ≥60 秒" 1 "$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_smoke/range.bin&ttl=1" | python3 -c "
import json,sys,time,urllib.parse as up
q=up.parse_qs(up.urlparse(json.load(sys.stdin)['url']).query)
print(1 if int(q['exp'][0]) - int(time.time()) >= 55 else 0)")"
check "超长 ttl 被夹到 ≤1 小时" 1 "$(curl -s -u "$ADMIN" "$BASE/api/sign?key=_smoke/range.bin&ttl=999999" | python3 -c "
import json,sys,time,urllib.parse as up
q=up.parse_qs(up.urlparse(json.load(sys.stdin)['url']).query)
print(1 if int(q['exp'][0]) - int(time.time()) <= 3700 else 0)")"

section "13.10 预览 token 与浏览器缓存（省掉每次签名的往返）"
atleast "whoami 下发预览 token" 1 "$(curl -s -u "$ADMIN" "$BASE/api/whoami" | grep -c 'previewToken":"')"
PT="$(curl -s -u "$ADMIN" "$BASE/api/whoami" | python3 -c "
import json,sys
print(json.load(sys.stdin).get('previewToken') or '')" 2>/dev/null)"
check "预览 token 可直接读直链（无需再签名）" 200 "$(code "$BASE/raw/_smoke/range.bin?pt=$PT")"
check "预览 token 支持 Range" 206 "$(code -H 'Range: bytes=0-3' "$BASE/raw/_smoke/range.bin?pt=$PT")"
check "普通文件响应带私有缓存头（浏览器可缓存）" 1 "$(curl -s -D- -o /dev/null "$BASE/raw/_smoke/range.bin?pt=$PT" | grep -ci 'cache-control: private, max-age=')"
check "写入缩略图探针 201" 201 "$(acode -X PUT --data 'x' -H 'Content-Type: image/png' "$BASE/webdav/_%24flaredrive%24/thumbnails/0000000000000000000000000000000000000001.png")"
check "缩略图仍是长缓存" 1 "$(curl -s -D- -o /dev/null "$BASE/raw/_%24flaredrive%24/thumbnails/0000000000000000000000000000000000000001.png" | grep -ci 'max-age=31536000' || echo 0)"
check "清理缩略图探针 204" 204 "$(acode -X DELETE "$BASE/webdav/_%24flaredrive%24/thumbnails/0000000000000000000000000000000000000001.png")"

section "13.11 全局搜索（跨目录）"
check "建搜索测试目录 201" 201 "$(acode -X MKCOL "$W/search-a")"
check "建搜索子目录 201" 201 "$(acode -X MKCOL "$W/search-a/deep")"
# 用独特关键词，避免与其它测试或历史数据撞车（撞了会让计数断言失真）
SQ="zqprobe"
SQUP="$(printf '%s' "$SQ" | tr 'a-z' 'A-Z')"
check "写入跨目录文件 1 201" 201 "$(acode -X PUT --data 'x' "$W/search-a/$SQ-one.txt")"
check "写入跨目录文件 2 201" 201 "$(acode -X PUT --data 'x' "$W/search-a/deep/$SQ-two.txt")"
check "写入跨目录文件 3 201" 201 "$(acode -X PUT --data 'x' "$W/search-a/$SQUP-three.txt")"
check "写入不匹配文件 201" 201 "$(acode -X PUT --data 'x' "$W/search-a/unrelated.txt")"
SEARCHJSON="$(curl -s -u "$ADMIN" "$BASE/api/search?q=$SQ")"
check "跨目录命中 3 条" 3 "$(printf '%s' "$SEARCHJSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")"
atleast "结果含深层目录的文件" 1 "$(printf '%s' "$SEARCHJSON" | grep -c "deep/$SQ-two")"
check "大小写不敏感" 3 "$(curl -s -u "$ADMIN" "$BASE/api/search?q=$SQUP" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")"
check "空关键词 400" 400 "$(acode "$BASE/api/search")"
check "limit 生效并标记截断" "1/True" "$(curl -s -u "$ADMIN" "$BASE/api/search?q=$SQ&limit=1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"{d['total']}/{d['truncated']}\")")"
check "prefix 限定范围（只在 deep 里找）" 1 "$(curl -s -u "$ADMIN" "$BASE/api/search?q=$SQ&prefix=_smoke/search-a/deep" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")"
acode -X DELETE "$W/search-a/$SQ-one.txt" > /dev/null
check "搜不到刚进回收站的内容" 0 "$(curl -s -u "$ADMIN" "$BASE/api/search?q=$SQ-one" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")"
check "搜不到内部目录（缩略图）" 0 "$(curl -s -u "$ADMIN" "$BASE/api/search?q=thumbnails" | python3 -c "import json,sys; print(json.load(sys.stdin)['total'])")"
check "公开读模式下匿名也能搜" 200 "$(code "$BASE/api/search?q=$SQ")"
check "清理搜索测试目录 204" 204 "$(acode -X DELETE "$W/search-a")"

section "13.12 分片上传：断点续传与放弃任务"
MP="$W/multipart"
check "建分片测试目录 201" 201 "$(acode -X MKCOL "$MP")"
MPCREATE="$(curl -s -u "$ADMIN" -X POST "$MP/chunk.bin?uploads")"
MPID="$(printf '%s' "$MPCREATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uploadId') or '')" 2>/dev/null)"
atleast "创建分片任务返回 uploadId" 1 "$(printf '%s' "$MPID" | grep -c .)"
# 分片必须 ≥5MB（R2 限制），这里用 5MB + 1MB 两片
head -c 5000000 /dev/zero > /tmp/smoke-part1.bin
head -c 1000000 /dev/zero > /tmp/smoke-part2.bin
MPE1="$(curl -s -D- -o /dev/null -u "$ADMIN" -X PUT --data-binary @/tmp/smoke-part1.bin "$MP/chunk.bin?uploadId=$MPID&partNumber=1" | tr -d '\r' | grep -i '^etag:' | cut -d' ' -f2)"
check "传第一片 200" 1 "$(printf '%s' "$MPE1" | grep -c .)"
check "分片响应带 etag" 1 "$(printf '%s' "$MPE1" | grep -c .)"
check "放弃任务 204" 204 "$(acode -X DELETE "$MP/chunk.bin?uploadId=$MPID")"
check "放弃后同一任务不能再传片 400" 400 "$(acode -X PUT --data-binary @/tmp/smoke-part2.bin "$MP/chunk.bin?uploadId=$MPID&partNumber=2")"
check "放弃不存在的任务是幂等的 204" 204 "$(acode -X DELETE "$MP/chunk.bin?uploadId=not-a-real-upload")"
check "放弃任务不会删掉同名已存在对象 201" 201 "$(acode -X PUT --data 'keep' "$MP/chunk.bin")"
MPID2="$(curl -s -u "$ADMIN" -X POST "$MP/chunk.bin?uploads" | python3 -c "import json,sys; print(json.load(sys.stdin).get('uploadId') or '')")"
check "对已有对象也能开分片任务" 1 "$(printf '%s' "$MPID2" | grep -c .)"
acode -X DELETE "$MP/chunk.bin?uploadId=$MPID2" > /dev/null
check "放弃后原对象还在" "keep" "$(curl -s "$MP/chunk.bin")"
check "清理分片测试目录 204" 204 "$(acode -X DELETE "$MP")"

section "13.13 分段 PUT（Content-Range）必须被拒绝，避免静默损坏"
CR="$W/range-put"
check "建目录 201" 201 "$(acode -X MKCOL "$CR")"
head -c 200000 /dev/zero > /tmp/smoke-cr-full.bin
head -c 1000 /dev/zero > /tmp/smoke-cr-part.bin
check "先正常上传 1 个文件 201" 201 "$(acode -X PUT --data-binary @/tmp/smoke-cr-full.bin "$CR/doc.bin")"
check "文件大小正确" 200000 "$(curl -s -o /dev/null -w '%{size_download}' "$W/range-put/doc.bin")"
check "分段 PUT 被拒 501" 501 "$(acode -X PUT -H 'Content-Range: bytes 0-999/200000' --data-binary @/tmp/smoke-cr-part.bin "$CR/doc.bin")"
check "被拒后原文件没有被截断" 200000 "$(curl -s -o /dev/null -w '%{size_download}' "$W/range-put/doc.bin")"
check "拒绝文案说明原因" 1 "$(curl -s -u "$ADMIN" -X PUT -H 'Content-Range: bytes 0-999/200000' --data-binary @/tmp/smoke-cr-part.bin "$CR/doc.bin" | grep -c '不支持分段 PUT')"
check "等价整文件的 Content-Range 放行 201" 201 "$(acode -X PUT -H 'Content-Range: bytes 0-199999/200000' --data-binary @/tmp/smoke-cr-full.bin "$CR/whole.bin")"
check "整文件形式写入正确" 200000 "$(curl -s -o /dev/null -w '%{size_download}' "$W/range-put/whole.bin")"
check "普通 PUT 不受影响 201" 201 "$(acode -X PUT --data-binary @/tmp/smoke-cr-part.bin "$CR/plain.bin")"
check "清理 204" 204 "$(acode -X DELETE "$CR")"

section "13.14 解压并发与流式进度"
UZ="$W/unzip-progress"
check "建目录 201" 201 "$(acode -X MKCOL "$UZ")"
# 造一个多条目 zip（用 python 生成，保证条目数够看进度）
python3 - "$PWD" <<'PYEOF'
import zipfile, sys, os
path = os.path.join("/tmp", "smoke-progress.zip")
with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
    for i in range(25):
        z.writestr(f"p{i%2}/f{i:02d}.txt", "x" * 200)
PYEOF
check "上传测试 zip 201" 201 "$(acode -X PUT --data-binary @/tmp/smoke-progress.zip "$UZ/pack.zip")"
UZOUT="$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"mode":"skip"}' "$BASE/api/unzip/_smoke/unzip-progress/pack.zip")"
atleast "返回 NDJSON 进度流" 1 "$(printf '%s' "$UZOUT" | grep -c '"type":"progress"')"
atleast "以 done 事件收尾" 1 "$(printf '%s' "$UZOUT" | grep -c '"type":"done"')"
check "done 报告条目数" 25 "$(printf '%s' "$UZOUT" | tail -1 | python3 -c "import json,sys; print(json.load(sys.stdin)['files'])")"
atleast "进度里的 total 正确" 1 "$(printf '%s' "$UZOUT" | grep -c '"total":25')"
check "解压内容正确" 200 "$(curl -s -o /dev/null -w '%{size_download}' "$W/unzip-progress/p0/f00.txt")"
check "check 预检仍是普通 JSON（不是流）" 1 "$(curl -s -u "$ADMIN" -X POST -H 'Content-Type: application/json' -d '{"mode":"check"}' "$BASE/api/unzip/_smoke/unzip-progress/pack.zip" | grep -c '"conflictCount"')"
check "清理 204" 204 "$(acode -X DELETE "$UZ")"

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
