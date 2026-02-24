// ===================================================
// KaizenTerm — Focus Timer (Pomodoro / Kaizen)
// ===================================================

const ACTIVITY_SUGGESTIONS = [
    { emoji: '🚶', text: 'Dá una vuelta caminando' },
    { emoji: '🏋️', text: 'Hacé 10 sentadillas' },
    { emoji: '🧘', text: 'Estirá brazos y espalda' },
    { emoji: '💧', text: 'Tomá un vaso de agua' },
    { emoji: '👀', text: 'Mirá lejos 20 segundos (ejercicio 20-20-20)' },
    { emoji: '🫁', text: 'Respirá profundo 5 veces' },
    { emoji: '🏋️', text: 'Hacé 10 flexiones' },
    { emoji: '🧍', text: 'Caminá por la casa 2 minutos' },
];

export class FocusTimer {
    private seconds: number;
    private isRunning: boolean = false;
    private isBreak: boolean = false;
    private cycles: number;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private _activityIntervalId: ReturnType<typeof setInterval> | null = null;
    private workDuration: number = 25 * 60;
    private breakDuration: number = 5 * 60;
    private longBreakDuration: number = 15 * 60;
    private activityReminderMinutes: number = 45;
    private _sessionStartTime: number = Date.now();

    private timerEl: HTMLElement;
    private valueEl: HTMLElement;
    private toggleBtn: HTMLElement;
    private cyclesEl: HTMLElement;

    private onCycleComplete?: (cycles: number) => void;

    constructor(
        timerEl: HTMLElement,
        initialSeconds: number = 25 * 60,
        initialCycles: number = 0
    ) {
        this.timerEl = timerEl;
        this.seconds = initialSeconds;
        this.cycles = initialCycles;

        this.valueEl = document.getElementById('timer-value')!;
        this.toggleBtn = document.getElementById('timer-toggle')!;
        this.cyclesEl = document.getElementById('timer-cycles')!;

        this.toggleBtn.addEventListener('click', () => this.toggle());
        this.timerEl.addEventListener('dblclick', () => this.reset());

        // Right-click to configure durations
        this.timerEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            window.dispatchEvent(new CustomEvent('kaizen-timer-config'));
        });

        this.updateDisplay();
        this.startActivityReminder();
    }

    setCycleCallback(cb: (cycles: number) => void) {
        this.onCycleComplete = cb;
    }

    setDurations(workMin: number, breakMin: number, longBreakMin: number) {
        this.workDuration = workMin * 60;
        this.breakDuration = breakMin * 60;
        this.longBreakDuration = longBreakMin * 60;
        // If not currently running, reset to new work duration
        if (!this.isRunning && !this.isBreak) {
            this.seconds = this.workDuration;
            this.updateDisplay();
        }
    }

    getDurations() {
        return {
            work: this.workDuration / 60,
            break: this.breakDuration / 60,
            longBreak: this.longBreakDuration / 60,
        };
    }

    toggle() {
        if (this.isRunning) {
            this.pause();
        } else {
            this.start();
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.toggleBtn.textContent = '⏸';
        this.timerEl.classList.add('running');
        if (this.isBreak) {
            this.timerEl.classList.add('break-time');
        }

        this.intervalId = setInterval(() => {
            this.seconds--;
            this.updateDisplay();

            if (this.seconds <= 0) {
                this.onTimerEnd();
            }
        }, 1000);
    }

    pause() {
        if (!this.isRunning) return;
        this.isRunning = false;
        this.toggleBtn.textContent = '▶';
        this.timerEl.classList.remove('running');

        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    reset() {
        this.pause();
        this.isBreak = false;
        this.seconds = this.workDuration;
        this.timerEl.classList.remove('break-time');
        this.updateDisplay();
    }

    private onTimerEnd() {
        this.pause();

        if (!this.isBreak) {
            // Work period ended
            this.cycles++;
            this.onCycleComplete?.(this.cycles);

            const isLongBreak = this.cycles % 4 === 0;
            if (isLongBreak) {
                const activity = this.getRandomActivity();
                this.showNotification(
                    `${activity.emoji} Descanso largo — Ciclo ${this.cycles}`,
                    `${activity.text}. Tomáte ${this.longBreakDuration / 60} minutos.`
                );
            } else {
                this.showNotification(
                    '🎯 Ciclo de foco completo!',
                    `Ciclo ${this.cycles} listo. Descansá ${this.breakDuration / 60} minutos.`
                );
            }

            this.isBreak = true;
            this.timerEl.classList.add('break-time');
            this.seconds = isLongBreak ? this.longBreakDuration : this.breakDuration;
        } else {
            // Break ended
            this.showNotification('⚡ Descanso terminado!', 'Listo para el siguiente ciclo de foco.');
            this.isBreak = false;
            this.timerEl.classList.remove('break-time');
            this.seconds = this.workDuration;
        }

        this.updateDisplay();
        window.dispatchEvent(new CustomEvent('kaizen-state-change'));
    }

    // Activity reminder every 45 minutes regardless of timer state
    private startActivityReminder() {
        this._sessionStartTime = Date.now();
        this._activityIntervalId = setInterval(() => {
            const activity = this.getRandomActivity();
            this.showNotification(
                `${activity.emoji} Pausa activa`,
                activity.text
            );
        }, this.activityReminderMinutes * 60 * 1000);
    }

    private getRandomActivity() {
        return ACTIVITY_SUGGESTIONS[Math.floor(Math.random() * ACTIVITY_SUGGESTIONS.length)];
    }

    private updateDisplay() {
        const mins = Math.floor(this.seconds / 60);
        const secs = this.seconds % 60;
        this.valueEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        this.cyclesEl.textContent = `${this.cycles} cycle${this.cycles !== 1 ? 's' : ''}`;
    }

    private showNotification(title: string, body: string) {
        const container = document.querySelector('.toast-container') || this.createToastContainer();
        const toast = document.createElement('div');
        toast.className = 'toast info activity-toast';
        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.textContent = '🔲';
        const text = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = title;
        text.appendChild(strong);
        text.appendChild(document.createElement('br'));
        text.appendChild(document.createTextNode(body));
        toast.appendChild(icon);
        toast.appendChild(text);
        container.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-fade-out');
            setTimeout(() => toast.remove(), 300);
        }, 6000);

        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body, icon: '🔲' });
        }
    }

    private createToastContainer(): HTMLElement {
        const container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
        return container;
    }

    getState() {
        return {
            seconds: this.seconds,
            cycles: this.cycles,
            isRunning: this.isRunning,
            isBreak: this.isBreak,
        };
    }
}
