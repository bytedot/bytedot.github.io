document.addEventListener('DOMContentLoaded', function() {
  function updateClock() {
    const now = new Date();
    // 调整为 UTC-4 时区
    const utcTime = now.getTime() + (now.getTimezoneOffset() * 60000);
    const edtTime = new Date(utcTime - (4 * 60 * 60 * 1000));
    
    // 格式化时间: HH:MM:SS
    const hours = edtTime.getHours().toString().padStart(2, '0');
    const minutes = edtTime.getMinutes().toString().padStart(2, '0');
    const seconds = edtTime.getSeconds().toString().padStart(2, '0');
    
    // 格式化日期: YYYY-MM-DD
    const year = edtTime.getFullYear();
    const month = (edtTime.getMonth() + 1).toString().padStart(2, '0');
    const day = edtTime.getDate().toString().padStart(2, '0');
    
    // 获取星期几
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const weekday = weekdays[edtTime.getDay()];
    
    // 更新显示
    document.getElementById('edt-clock').innerHTML = 
      `EDT (UTC-4): ${year}-${month}-${day} ${weekday} ${hours}:${minutes}:${seconds}`;
  }
  
  // 初始更新
  updateClock();
  
  // 每秒更新一次
  setInterval(updateClock, 1000);
});