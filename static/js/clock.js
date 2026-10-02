document.addEventListener('DOMContentLoaded', function() {
  const clock = document.getElementById('central-clock');
  if (!clock) return;

  // 明尼阿波利斯使用 America/Chicago，自动应用夏令时和冬令时。
  const timeZone = 'America/Chicago';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  });
  const offsetFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset'
  });
  const weekdays = {
    Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三',
    Thu: '周四', Fri: '周五', Sat: '周六'
  };

  function updateClock() {
    const now = new Date();
    const parts = Object.fromEntries(
      formatter.formatToParts(now).map(part => [part.type, part.value])
    );
    const offset = offsetFormatter.formatToParts(now)
      .find(part => part.type === 'timeZoneName').value.replace('GMT', 'UTC');

    clock.textContent =
      `${parts.timeZoneName} (${offset}): ` +
      `${parts.year}-${parts.month}-${parts.day} ${weekdays[parts.weekday]} ` +
      `${parts.hour}:${parts.minute}:${parts.second}`;
  }
  
  // 初始更新
  updateClock();
  
  // 每秒更新一次
  setInterval(updateClock, 1000);
});
