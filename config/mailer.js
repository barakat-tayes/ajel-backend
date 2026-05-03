const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || "false") === "true",
  auth: {
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
  },
});

const sendOtpMail = async ({ to, otpCode }) => {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  if (!from) throw new Error("SMTP_FROM/SMTP_USER is not configured");
  await transporter.sendMail({
    from,
    to,
    subject: "رمز استعادة كلمة المرور - عاجل",
    html: `<div dir="rtl" style="font-family:Arial,sans-serif">
      <h3>رمز استعادة كلمة المرور</h3>
      <p>رمز التحقق الخاص بك هو:</p>
      <div style="font-size:28px;font-weight:bold;letter-spacing:4px">${otpCode}</div>
      <p>صلاحية الرمز: 10 دقائق.</p>
    </div>`,
  });
};

module.exports = { sendOtpMail };
