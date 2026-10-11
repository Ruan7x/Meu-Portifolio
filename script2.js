const video = document.getElementById('introVideo'); const intro = document.getElementById('intro'); const enterButton = document.getElementById('enterButton'); const progressBar = document.getElementById('progressBar'); const percentage = document.getElementById('percentage');
video.addEventListener('timeupdate', () => { if (!video.duration) return; const progress = video.currentTime / video.duration * 100; progressBar.style.width = `${progress}%`; percentage.textContent = `${Math.floor(progress)}%` });
function entrar() { intro.classList.add('exit'); setTimeout(() => { window.location.href = 'index.html' }, 1000) }
video.addEventListener('ended', () => { progressBar.style.width = '100%'; percentage.textContent = '100%'; setTimeout(entrar, 1000) }); enterButton.addEventListener('click', entrar);
const splash = document.getElementById('splash');
const startButton = document.getElementById('startButton');

startButton.addEventListener('click', () => {
    video.muted = false;
    video.volume = 1;
    video.play();
    splash.classList.add('hide');
    intro.classList.add('started');
});