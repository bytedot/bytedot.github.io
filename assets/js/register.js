(() => {
  const form = document.getElementById('registration-form');
  if (!form) return;

  const username = document.getElementById('registration-username');
  const email = document.getElementById('registration-email');
  const password = document.getElementById('registration-password');
  const status = document.getElementById('registration-status');
  const submit = document.getElementById('registration-submit');
  const fields = [username, email, password];
  const loading = [
    document.getElementById('username-loading'),
    document.getElementById('password-loading')
  ];
  let checking = false;

  function showError(input, errorId, message) {
    input.setAttribute('aria-invalid', 'true');
    const error = document.getElementById(errorId);
    error.textContent = message;
    error.hidden = false;
  }

  function clearErrors() {
    for (const field of fields) field.removeAttribute('aria-invalid');
    for (const id of ['username-error', 'email-error', 'password-error']) {
      document.getElementById(id).hidden = true;
    }
    status.hidden = true;
    status.textContent = '';
  }

  function setChecking(value) {
    checking = value;
    form.setAttribute('aria-busy', String(value));
    for (const field of fields) field.disabled = value;
    for (const indicator of loading) indicator.hidden = !value;
    submit.disabled = value;
    submit.textContent = value ? '正在注册…' : '注册账户';
    status.classList.toggle('is-checking', value);
  }

  for (const field of fields) {
    field.addEventListener('input', () => {
      if (!checking) clearErrors();
    });
  }

  form.addEventListener('submit', event => {
    // 本地演示：仅更新页面状态，不发送、记录或保存任何输入。
    event.preventDefault();
    if (checking) return;
    clearErrors();

    let firstInvalid = null;
    if (!username.value.trim()) {
      showError(username, 'username-error', '请输入用户名。');
      firstInvalid = username;
    }
    if (!email.validity.valid) {
      showError(email, 'email-error', email.value.trim()
        ? '请输入有效的邮箱地址。' : '请输入邮箱地址。');
      firstInvalid = firstInvalid || email;
    }
    if (!password.value) {
      showError(password, 'password-error', '请输入密码。');
      firstInvalid = firstInvalid || password;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    setChecking(true);
    status.textContent = '正在检查用户名和密码…';
    status.hidden = false;

    setTimeout(() => {
      setChecking(false);
      showError(username, 'username-error', '用户名已被占用，请更换用户名。');
      showError(password, 'password-error', '密码强度太弱，需要强密码。');
      status.textContent = '注册未完成：用户名已被占用，密码强度太弱，需要强密码。';
      username.focus();
    }, 1600);
  });

  submit.disabled = false;
})();
