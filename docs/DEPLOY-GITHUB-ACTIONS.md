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

## گام ۱ — یک دستور روی سرور

```bash
cd /opt/anon-video
git pull
./scripts/setup-deploy-key.sh
```

این اسکریپت همه‌ی کارها را می‌کند:

1. یک کلید SSH **اختصاصیِ فقط برای CI** می‌سازد (`~/.ssh/anon_video_deploy`)
2. کلید عمومی را روی همین سرور در `authorized_keys` نصب می‌کند
3. ورود با کلید را **واقعاً تست می‌کند**
4. آی‌پی و اثر انگشت سرور را پیدا می‌کند
5. در پایان دقیقاً می‌گوید کدام مقدار در کدام Secret باید برود

> کلید خصوصی فقط روی صفحه‌ی ترمینال خودتان چاپ می‌شود و جایی فرستاده
> نمی‌شود. بعد از کپی کردن `clear` بزنید.

> چرا کلید جدا و نه کلید خودتان؟ چون هر وقت خواستید می‌توانید فقط همین یکی
> را باطل کنید، بدون اینکه دسترسی خودتان قطع شود.

## گام ۲ — کپی کردن در GitHub

به `https://github.com/Cmd81/chatbot/settings/secrets/actions` بروید و
**New repository secret** بزنید. خروجی اسکریپت دقیقاً همین‌ها را می‌دهد:

| نام | از کجا |
|---|---|
| `DEPLOY_HOST` | آی‌پی سرور — اسکریپت چاپ می‌کند |
| `DEPLOY_USER` | معمولاً `root` — اسکریپت چاپ می‌کند |
| `DEPLOY_SSH_KEY` | کل متن کلید خصوصی، شامل خط‌های BEGIN و END |
| `DEPLOY_KNOWN_HOSTS` | اثر انگشت سرور (اختیاری ولی توصیه‌شده) |
| `TELEGRAM_BOT_TOKEN` | توکن ربات — فقط بار اولِ استقرار لازم است |
| `DEPLOY_PORT` | فقط اگر SSH روی پورتی غیر از ۲۲ است |

### Variables (اختیاری)

اگر دامنه‌هایتان همین‌هاست لازم نیست؛ پیش‌فرض همین است. در تب **Variables**:

| نام | مقدار |
|---|---|
| `PUBLIC_HOST` | `chat.onlane.top` |
| `TURN_HOST` | `turn.onlane.top` |
| `ACME_EMAIL` | ایمیل واقعی شما |

## گام ۳ — خاموش کردن به‌روزرسانی زمان‌بندی‌شده

اگر `install-autoupdate.sh` را نصب کرده‌اید، دیگر لازم نیست:

```bash
./scripts/install-autoupdate.sh off
```

> اگر هر دو را روشن بگذارید خرابی پیش نمی‌آید — هر دو از یک `flock` مشترک
> استفاده می‌کنند و روی هم نمی‌افتند — ولی دوباره‌کاری است.

## گام ۴ — اولین استقرار

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
