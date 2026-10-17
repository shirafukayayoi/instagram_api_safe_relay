"""専用ChromiumのInstagramセッションをローカルHTTPモード用に保存する。"""
import argparse
import json
import os
from pathlib import Path
import sys
from yt_dlp.cookies import extract_cookies_from_browser


class Quiet:
    def info(self, *args, **kwargs): pass
    def warning(self, *args, **kwargs): pass
    def debug(self, *args, **kwargs): pass
    def error(self, *args, **kwargs):
        raise RuntimeError("セッションを読み込めません。手動ログインと復号環境を確認してください")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user-data-dir', required=True, type=Path)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('--username', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--keyring', default=None)
    args = parser.parse_args()
    jar = extract_cookies_from_browser('chromium', str(args.user_data_dir.resolve() / 'Default'), Quiet(), keyring=args.keyring)
    names = {'sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur'}
    cookies = [{'name': c.name, 'value': c.value, 'domain': c.domain, 'path': c.path,
                'secure': bool(c.secure), 'expires': c.expires}
               for c in jar if c.domain.lstrip('.') == 'instagram.com' and c.name in names and c.path == '/']
    by_name = {c['name']: c['value'] for c in cookies}
    if not {'sessionid', 'csrftoken', 'ds_user_id'} <= by_name.keys() or by_name['ds_user_id'] != args.account_id:
        raise RuntimeError('ログイン情報が不足しているか、指定アカウントと一致しません')
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # 上書きしない。既存セッションを保持し、移行先はGit管理外に置く。
    fd = os.open(args.output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump({'version': 1, 'account': {'id': args.account_id, 'username': args.username},
                   'userAgent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
                   'cookies': cookies}, output)
    print('専用プロファイルのInstagramセッションを権限600のファイルへ保存しました')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('移行を停止しました。ログイン状態・保存先・復号環境を確認してください。認証値は表示しません', file=sys.stderr)
        sys.exit(1)
