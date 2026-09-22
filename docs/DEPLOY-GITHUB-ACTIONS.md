# استقرار خودکار با GitHub Actions

چون محیط اجرای دستیار اجازه‌ی خروجی SSH ندارد، استقرار از **runnerهای گیت‌هاب**
انجام می‌شود که خروجی آزاد دارند. نتیجه: با هر پوش (یا با یک کلیک) سرور به‌روز
می‌شود.

```
  پوش به گیت‌هاب
        │
        ▼
  GitHub Runner  ──ssh──▶  سرور شما
   (rsync کد)              ├─ بار اول : deploy.sh (داکر + .env + ufw + build)
                           └─ بارهای بعد: docker compose build && up -d
```

---

## گام ۱ — ساخت کلید اختصاصی

**روی کامپیوتر خودتان** (نه روی سرور) یک کلید فقط برای CI بسازید:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/anon_video_deploy -N ""
```

دو فایل ساخته می‌شود:

| فایل | کاربرد |
|---|---|
| `~/.ssh/anon_video_deploy` | **کلید خصوصی** → به GitHub Secrets می‌رود |
| `~/.ssh/anon_video_deploy.pub` | **کلید عمومی** → روی سرور نصب می‌شود |

> چرا کلید جدا؟ چون هر وقت خواستید می‌توانید فقط همین یکی را باطل کنید، بدون
> اینکه دسترسی خودتان قطع شود.

## گام ۲ — نصب کلید عمومی روی سرور

```bash
ssh-copy-id -i ~/.ssh/anon_video_deploy.pub root@167.104.219.227
```

اگر `ssh-copy-id` ندارید:

```bash
cat ~/.ssh/anon_video_deploy.pub | ssh root@167.104.219.227 \
  'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'
```

تست کنید که بدون پسورد وارد می‌شوید:

```bash
ssh -i ~/.ssh/anon_video_deploy root@167.104.219.227 'echo OK'
```

## گام ۳ — گرفتن اثر انگشت سرور

این کار جلوی حمله‌ی MITM روی اتصال runner را می‌گیرد:

```bash
ssh-keyscan -p 22 -H 167.104.219.227
```

تمام خروجی را کپی کنید (چند خط است).

## گام ۴ — افزودن Secrets و Variables

به `https://github.com/Cmd81/chatbot/settings/secrets/actions` بروید.

### تب Secrets → New repository secret

| نام | مقدار |
|---|---|
| `DEPLOY_HOST` | `167.104.219.227` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | **تمام محتوای** `~/.ssh/anon_video_deploy` — شامل خط‌های `-----BEGIN ...` و `-----END ...` |
| `DEPLOY_KNOWN_HOSTS` | خروجی گام ۳ (اختیاری ولی توصیه‌شده) |
| `TELEGRAM_BOT_TOKEN` | توکن ربات — فقط بار اول لازم است |
| `DEPLOY_PORT` | فقط اگر SSH روی پورتی غیر از ۲۲ است |

```bash
# نمایش کلید خصوصی برای کپی:
cat ~/.ssh/anon_video_deploy
```

### تب Variables → New repository variable

اگر دامنه‌هایتان همین‌هاست، این‌ها اختیاری‌اند (پیش‌فرض همین است):

| نام | مقدار |
|---|---|
| `PUBLIC_HOST` | `chat.onlane.top` |
| `TURN_HOST` | `turn.onlane.top` |
| `ACME_EMAIL` | ایمیل واقعی شما برای Let's Encrypt |

## گام ۵ — اجرای اولین استقرار

به `https://github.com/Cmd81/chatbot/actions` بروید:

1. از ستون چپ **«استقرار روی سرور»** را انتخاب کنید
2. دکمه‌ی **Run workflow** را بزنید
3. برنچ `claude/anonymous-video-call-mvp-qb1wwg` را انتخاب کنید
4. ✅ تیک **«استقرار کامل»** را بزنید — **بار اول حتماً لازم است**
5. **Run workflow**

⏱ بار اول ۱۰ تا ۱۵ دقیقه طول می‌کشد (کامپایل Caddy با افزونه‌ی layer4 + ساخت ایمیج‌ها).

در پایان، در تب Summary آدرس سایت و کد پاسخ HTTP را می‌بینید.

## بارهای بعد

از این به بعد هر پوش به `main` یا برنچ فعلی، **خودکار** استقرار می‌شود — بدون تیک
«استقرار کامل»، پس سریع است (فقط `docker compose build && up -d`).
تغییرات فقط در فایل‌های `.md` و پوشه‌ی `docs/` استقرار را راه نمی‌اندازند.

فایل `.env` و گواهی‌های Let's Encrypt روی سرور **هرگز پاک نمی‌شوند**
(`rsync --delete` آن‌ها را exclude می‌کند).

---

## تنها کار دستی باقی‌مانده

در تلگرام، [@BotFather](https://t.me/BotFather):

```
/mybots → ربات شما → Bot Settings → Menu Button → https://chat.onlane.top
```

---

## نکات امنیتی — صادقانه

**این workflow عملاً دسترسی root به سرور دارد.** راهی برای کم کردن واقعی این
دسترسی وجود ندارد: نصب بسته، مدیریت ufw و اجرای داکر همگی root می‌خواهند، و
کاربرِ عضو گروه `docker` هم عملاً معادل root است. پس:

- **هر کسی که بتواند به برنچ‌های trigger پوش کند یا workflow را دستی اجرا کند،
  می‌تواند روی سرور شما کد با دسترسی root اجرا کند.** دسترسی پوش ریپو را محدود
  نگه دارید و branch protection بگذارید.
- برای یک لایه‌ی اضافه، در `Settings → Environments` یک environment به نام
  `production` با **Required reviewers** بسازید و در workflow زیر `jobs.deploy`
  خط `environment: production` را اضافه کنید. آن‌وقت هر استقرار نیاز به تأیید
  دستی دارد.
- بعد از اینکه ورود با کلید را تست کردید، ورود با پسورد را ببندید:
  ```bash
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  systemctl restart ssh
  ```
- 🔴 **پسورد فعلی root را عوض کنید** — در گفتگو به‌صورت متن ساده فرستاده شده بود:
  ```bash
  passwd root
  ```
- توکن ربات فقط در GitHub Secrets و در `.env` روی سرور (با دسترسی `600`) است؛
  هرگز داخل گیت نمی‌رود.

---

## عیب‌یابی

<details>
<summary><b>Permission denied (publickey)</b></summary>

- مطمئن شوید محتوای `DEPLOY_SSH_KEY` **کل فایل** است، شامل خط‌های
  `-----BEGIN OPENSSH PRIVATE KEY-----` و `-----END OPENSSH PRIVATE KEY-----`
- کلید نباید passphrase داشته باشد (با `-N ""` ساخته شد)
- `DEPLOY_USER` باید دقیقاً همان کاربری باشد که کلید عمومی در
  `~/.ssh/authorized_keys` او قرار گرفته است
</details>

<details>
<summary><b>Host key verification failed</b></summary>

`DEPLOY_KNOWN_HOSTS` با خروجی فعلی `ssh-keyscan -p 22 -H <ip>` نمی‌خواند.
اگر سرور را بازسازی کرده‌اید، دوباره اجرا کنید و Secret را به‌روز کنید.
یا موقتاً این Secret را حذف کنید تا workflow خودش keyscan کند (امن‌تر نیست، ولی کار می‌کند).
</details>

<details>
<summary><b>استقرار سبز شد ولی سایت بالا نیامد</b></summary>

```bash
ssh root@167.104.219.227 'cd /opt/anon-video && ./scripts/verify.sh'
ssh root@167.104.219.227 'cd /opt/anon-video && docker compose logs --tail 80 caddy'
```

رایج‌ترین علت: دامنه پشت پروکسی Cloudflare است. ابر را خاکستری (DNS only) کنید.
</details>

<details>
<summary><b>می‌خواهم استقرار خودکار با هر پوش انجام نشود</b></summary>

در `.github/workflows/deploy.yml` کل بخش `push:` را حذف کنید. آن‌وقت فقط دکمه‌ی
**Run workflow** استقرار را شروع می‌کند.
</details>
