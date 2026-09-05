"""Release HTML selection keeps live and isolated demo entry points distinct."""
import pytest
from fastapi.testclient import TestClient
from hub.config import Settings
from hub.main import create_app


@pytest.mark.parametrize("built", [False, True])
@pytest.mark.parametrize("demo", [False, True])
def test_dashboard_entry_and_static_assets(tmp_path, built, demo):
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "index.html").write_text("legacy-live")
    (frontend / "demo.html").write_text("legacy-demo")
    if built:
        app_dir = frontend / "app"
        app_dir.mkdir()
        (app_dir / "index.html").write_text("built-live")
        (app_dir / "demo.html").write_text('built-demo data-cm-demo="1"')
        (app_dir / "asset.js").write_text("/* local asset */")
    settings = Settings(api_key="a" * 32, access_token="b" * 32,
        database_path=tmp_path / "db.sqlite3", frontend_dir=frontend,
        max_records_per_push=500, tm_background_enabled=False, cm_demo=demo,
        serve_demo_route=True)
    with TestClient(create_app(settings)) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.text.startswith(("built" if built else "legacy") + ("-demo" if demo else "-live"))
        assert "script-src 'self'" in response.headers["content-security-policy"]
        assert "-demo" in client.get("/demo").text
        if built:
            assert client.get("/static/app/asset.js").text == "/* local asset */"
        assert client.get("/api/v1/devices").status_code in (401, 403)
