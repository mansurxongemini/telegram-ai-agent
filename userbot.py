"""
Telegram Userbot — AI Autopilot
Mansurxon+ uchun. Butun Telegramni AI boshqaradi.
"""

import os
import json
import asyncio
import logging
from datetime import datetime
from telethon import TelegramClient, events
from telethon.tl.types import User, Chat, Channel
import httpx

# ========== SETTINGS ==========
API_ID = 36319482
API_HASH = "ed3143bea8b6df50b5ae7191dfaae1cf"
SESSION_NAME = "mansurxon_userbot"

# AI API settings (AutoGLM — OpenClaw bilan bir xil model)
AI_API_URL = "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions"
AI_AUTH_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjozNTM4MywiZGV2aWNlX2lkIjoiMzliNTExN2Q4NDhiYzE2NjQ5NTI4ZDZkODU4YWVjYTMwMTE3M2Q5ZWIyYWM5NTAzNjZlNmYxNzFkMjEyMmFlMyIsInNvdXJjZV9pZCI6ImF1dG9jbGF3YWNjZXNzX3Rva2VuIiwiZ3VpZCI6IiIsImlzX2d1ZXN0IjpmYWxzZSwicG93ZXIiOjAsImV4cCI6MTc4MTY5MzI0NiwiaWF0IjoxNzgxNjA2ODQ2LCJqdGkiOiJyLm1hbnN1cnhvbjAxQGdtYWlsLmNvbSJ9.2cXwHhuwlkR0rDqmTEVJ2H-IIb8Xxje9W5QIAWknwHc"

# Qaysi chatlarda avtomatik javob bersin
AUTO_REPLY_ENABLED = True
# Qaysi user/chat larni o'tkazib yuborsin (ID raqamlar)
IGNORE_IDS = set()  # masalan: {123456789, 987654321}

# ========== LOGGING ==========
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler("userbot.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("Userbot")

# ========== CLIENT ==========
client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

# ========== AI ==========
SYSTEM_PROMPT = """Siz Mansurxon+ nomli foydalanuvchining Telegram userbot AI yordamchisisiz.
Mansurxon+ o'rniga xabarlarni o'qiysiz va javob berasiz.
Tabiiy, do'stona va odam kabi yozing. Rasmiyatchilikdan qoching.

Muhim qoidalar:
- Mansurxon+ ning shaxsiy ma'lumotlarini hech kimga oshkor qilmang
- Agar xabar sizga murojaat qilinmagan bo'lsa va javob kerak bo'lmasa, javob bermang
- Guruh suhbatlarida faqat so'ralganda yoki murojaat qilinganda javob bering
- Qisqa va aniq javob bering
- O'zbek yoki rus tillarida suhbatdoshning tilida javob bering
- Hech qachon "AI", "userbot", "bot" ekanligingizni aytmang, oddiy odam kabi harakat qiling
- Spam qilmang, keraksiz xabarlar yozmang
- Shaxsiy suhbatlarda (DM) har doim javob bering"""


async def ask_ai(user_message: str, chat_context: str = "") -> str:
    """Send message to AI and get response."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]

    if chat_context:
        messages.append({
            "role": "system",
            "content": f"Hozirgi suhbat konteksti:\n{chat_context}"
        })

    messages.append({"role": "user", "content": user_message})

    headers = {
        "Content-Type": "application/json",
        "X-Authorization": f"Bearer {AI_AUTH_TOKEN}",
        "X-Request-Model": "zai_auto",
        "X-Product": "autoclaw",
    }

    payload = {
        "model": "auto",
        "messages": messages,
        "max_tokens": 1000,
        "temperature": 0.7,
        "stream": True,
    }

    try:
        async with httpx.AsyncClient(timeout=120.0) as http:
            full_response = []
            async with http.stream("POST", AI_API_URL, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    log.error(f"AI API xatosi: {resp.status_code}")
                    return ""
                async for line in resp.aiter_lines():
                    if line.startswith("data: "):
                        data_str = line[6:]
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                full_response.append(content)
                        except json.JSONDecodeError:
                            continue
            result = "".join(full_response).strip()
            return result
    except Exception as e:
        log.error(f"AI xatosi: {e}")
        return ""


# ========== MESSAGE HANDLER ==========
@client.on(events.NewMessage(incoming=True))
async def handle_message(event):
    """Handle all incoming messages."""
    if not AUTO_REPLY_ENABLED:
        return

    # Skip own messages
    if event.out:
        return

    sender = await event.get_sender()
    chat = await event.get_chat()
    message_text = event.text or ""

    # Skip ignored users/chats
    if sender.id in IGNORE_IDS or chat.id in IGNORE_IDS:
        return

    # Skip empty messages and media-only
    if not message_text.strip():
        return

    # Get chat name for context
    chat_name = getattr(chat, "title", None) or getattr(chat, "first_name", "Unknown")
    sender_name = getattr(sender, "first_name", "Unknown")

    # Only reply in DMs or when mentioned in groups
    is_dm = isinstance(chat, User) or (isinstance(chat, Chat) and not chat.title)

    me = await client.get_me()
    is_mentioned = f"@{me.username}" in message_text.lower() if me.username else False
    is_reply_to_me = False
    if event.reply_to:
        try:
            reply_to_id = getattr(event.reply_to, "from_id", None)
            if reply_to_id and hasattr(reply_to_id, "user_id"):
                is_reply_to_me = reply_to_id.user_id == me.id
        except Exception:
            pass

    if not is_dm and not is_mentioned and not is_reply_to_me:
        return  # Guruhda murojaat qilinmagan — jim turamiz

    log.info(f"Javob berilmoqda | Chat: {chat_name} | Kimdan: {sender_name} | Xabar: {message_text[:100]}")

    # Build context
    context = f"Chat: {chat_name}\nYuborgan: {sender_name}\nXabar turi: {'Shaxsiy' if is_dm else 'Guruh'}"
    if is_mentioned:
        context += "\n(Eslatma: sizga @mention orqali murojaat qilindi)"

    # Get AI response
    ai_prompt = f"Xabar: {message_text}\n\nIltimos, Mansurxon+ nomidan tabiiy javob bering."
    response = await ask_ai(ai_prompt, context)

    if response:
        try:
            await event.reply(response)
            log.info(f"Javob yuborildi → {chat_name}")
        except Exception as e:
            log.error(f"Javob yuborishda xato: {e}")


# ========== COMMAND HANDLERS ==========
@client.on(events.NewMessage(pattern=r"^/start", from_users="me"))
async def cmd_start(event):
    """Start — faqat siz yuborgan /start ga javob."""
    await event.reply(
        "🟢 **Userbot faol!**\n\n"
        "Men hozir sizning akkauntingizda ishlayapman.\n"
        "Buyruqlar:\n"
        "/status — holatni ko'rish\n"
        "/auto_on — avto-javobni yoqish\n"
        "/auto_off — avto-javobni o'chirish\n"
        "/ignore [ID] — foydalanuvchini e'tiborsiz qoldirish\n"
        "/unignore [ID] — e'tibordan chiqarish"
    )


@client.on(events.NewMessage(pattern=r"^/status", from_users="me"))
async def cmd_status(event):
    status = "🟢 AUTO" if AUTO_REPLY_ENABLED else "🔴 MANUAL"
    ignored = len(IGNORE_IDS)
    await event.reply(f"**Status:** {status}\n**Ignore dagilar:** {ignored} ta")


@client.on(events.NewMessage(pattern=r"^/auto_on", from_users="me"))
async def cmd_auto_on(event):
    global AUTO_REPLY_ENABLED
    AUTO_REPLY_ENABLED = True
    await event.reply("✅ Avto-javob YOQILDI")


@client.on(events.NewMessage(pattern=r"^/auto_off", from_users="me"))
async def cmd_auto_off(event):
    global AUTO_REPLY_ENABLED
    AUTO_REPLY_ENABLED = False
    await event.reply("🔴 Avto-javob O'CHIRILDI")


@client.on(events.NewMessage(pattern=r"^/ignore (\d+)", from_users="me"))
async def cmd_ignore(event):
    uid = int(event.pattern_match.group(1))
    IGNORE_IDS.add(uid)
    await event.reply(f"🚫 {uid} ignore ro'yxatiga qo'shildi")


@client.on(events.NewMessage(pattern=r"^/unignore (\d+)", from_users="me"))
async def cmd_unignore(event):
    uid = int(event.pattern_match.group(1))
    IGNORE_IDS.discard(uid)
    await event.reply(f"✅ {uid} ignore ro'yxatidan chiqarildi")


# ========== MAIN ==========
async def main():
    await client.start()
    me = await client.get_me()
    log.info(f"Userbot ishga tushdi: @{me.username} ({me.first_name})")

    print(f"""
    ╔══════════════════════════════════╗
    ║   🦞 Telegram Userbot TAYYOR   ║
    ║   Akkaunt: @{me.username or me.first_name}     ║
    ║   Auto-reply: {AUTO_REPLY_ENABLED}            ║
    ║   Ctrl+C — to'xtatish           ║
    ╚══════════════════════════════════╝
    """)

    await client.run_until_disconnected()


if __name__ == "__main__":
    if not API_ID or not API_HASH:
        print("❌ XATOLIK: API_ID va API_HASH ni to'ldiring!")
        print("1. https://my.telegram.org/apps saytiga kiring")
        print("2. API_ID va API_HASH ni oling")
        print("3. userbot.py faylini ochib, API_ID va API_HASH ni to'ldiring")
        exit(1)

    asyncio.run(main())
