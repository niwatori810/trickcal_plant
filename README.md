# trickcal_plant
トリッカルの工場の素材要求数を計算するwebサイトです
https://niwatori810.github.io/trickcal_plant/
これがサイト
https://github.com/niwatori810/trickcal_plant
ここがリポジトリ

## 構成

- `docs/index.html` — 公開ページ（生成物。直接編集しない）
- `docs/素材テーブル.json` — 素材とレシピ
- `docs/トリッカル生産ラボ - 必要素材.json` — 生産ラボの必要素材
- `docs/トリッカル研究素材まとめ - 必要素材.json` — 研究12段階の必要素材
- `tools/site/template.html` / `style.css` / `app.js` — 画面の元ファイル
- `tools/build_site.py` — データと画面の元ファイルから `docs/index.html` を生成

## バージョン・公開日

バージョンと公開日は `tools/site/template.html` の情報モーダル（`#info-dialog`）で管理しています。更新したら `docs/index.html` を再生成してください。

## 再生成

データや画面を変更したら、リポジトリ直下で:

```bash
uv run --no-project python tools/build_site.py
```

`docs/index.html` が再生成されます。生成物が最新か確認するだけなら:

```bash
uv run --no-project python tools/build_site.py --check
```

`--check` は書き込まず、差分があれば非0で終了します。データの不整合もここで検出します。`docs/index.html` を手で編集した場合、上書きは拒否されます（`--force` で強制）。

生成物はデータとアイコンを埋め込んだ単一HTMLなので、`docs/index.html` を直接開いても動作します。