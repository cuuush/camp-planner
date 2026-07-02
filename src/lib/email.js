const FROM = 'Camp Planner <camp@robot.cuuush.com>';

function retroTemplate({ heading, body, unsubscribeUrl }) {
    return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Comic Sans MS',cursive,sans-serif;background:#000080;color:#00ff00;">
  <div style="max-width:600px;margin:0 auto;padding:24px;border:4px dashed #ffff00;background:#000000;">
    <div style="text-align:center;font-size:20px;letter-spacing:2px;color:#ff00ff;">★ ★ ★ CAMP PLANNER ★ ★ ★</div>
    <h1 style="font-size:22px;color:#ffff00;">${heading}</h1>
    <p style="font-size:15px;color:#00ff00;line-height:1.5;">${body}</p>
    <p style="font-size:12px;color:#888;margin-top:32px;">
      u r getting this bc u signed up for email notifications.
      <a href="${unsubscribeUrl}" style="color:#00ffff;">unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}

// Notifications never block the triggering action — failures are swallowed by the caller.
export async function sendNotificationEmail(env, { to, heading, body, unsubscribeUrl }) {
    if (!env.RESEND_API_KEY || !to) return;

    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: FROM,
            to: [to],
            subject: heading,
            html: retroTemplate({ heading, body, unsubscribeUrl }),
        }),
    });

    if (!res.ok) {
        console.error('Resend error:', await res.text());
    }
}
