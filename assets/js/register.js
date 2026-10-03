(() => {
  const form = document.getElementById('registration-form');
  if (!form) return;

  const username = document.getElementById('registration-username');
  const email = document.getElementById('registration-email');
  const password = document.getElementById('registration-password');
  const status = document.getElementById('registration-status');
  const submit = document.getElementById('registration-submit');

  function rejectField(input, errorId) {
    input.setAttribute('aria-invalid', 'true');
    document.getElementById(errorId).hidden = false;
  }

  function validateEmail() {
    const error = document.getElementById('email-error');
    const valid = email.validity.valid;
    email.setAttribute('aria-invalid', String(!valid));
    error.textContent = email.value.trim()
      ? '请输入有效的邮箱地址。'
      : '请输入邮箱地址。';
    error.hidden = valid;
  }

  for (const eventName of ['input', 'blur']) {
    username.addEventListener(eventName, () => rejectField(username, 'username-error'));
    password.addEventListener(eventName, () => rejectField(password, 'password-error'));
    email.addEventListener(eventName, validateEmail);
  }

  form.addEventListener('submit', event => {
    // 趣味演示：仅更新页面提示，不发送、记录或保存任何输入。
    event.preventDefault();
    rejectField(username, 'username-error');
    rejectField(password, 'password-error');
    validateEmail();
    status.textContent = '注册未完成：用户名已被占用，密码强度太弱，需要强密码。';
    status.hidden = false;
    username.focus();
  });

  submit.disabled = false;
})();
