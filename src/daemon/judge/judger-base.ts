import { TestData, SubtaskScoringType, TestcaseJudge } from '../interfaces';
import { CompilationResult, JudgeResult, TaskStatus, SubtaskResult, TestcaseDetails } from '../../interfaces';
import { Language } from '../../languages';
import { compile } from './compile';
import winston = require('winston');
import _ = require('lodash');

const globalFullScore = 100;
function calculateSubtaskScore(scoring: SubtaskScoringType, scores: number[]): number {
    if (scoring === SubtaskScoringType.Minimum) {
        return _.min(scores);
    } else if (scoring === SubtaskScoringType.Multiple) {
        return _.reduce(scores,
            (res, cur) => res * cur, 1);
    } else if (scoring === SubtaskScoringType.Summation) {
        return _.sum(scores) / scores.length;
    }
}

export abstract class JudgerBase {
    priority: number;
    testData: TestData;

    constructor(t: TestData, p: number) {
        this.priority = p;
        this.testData = t;
    }

    abstract preprocessTestData(): Promise<void>;

    abstract compile(): Promise<CompilationResult>;

    async judge(reportProgressResult: (p: JudgeResult) => Promise<void>): Promise<JudgeResult> {
        const results: SubtaskResult[] = this.testData.subtasks.map(t => ({
            cases: t.cases.map(j => ({
                status: TaskStatus.Waiting
            })),
            status: TaskStatus.Waiting
        }));
        const reportProgress = function () {
            reportProgressResult({ status: TaskStatus.Running, subtasks: results });
        }
        winston.debug(`Totally ${results.length} subtasks.`);

        const judgeTasks: Promise<void>[] = [];
        for (let subtaskIndex = 0; subtaskIndex < this.testData.subtasks.length; subtaskIndex++) {
            const currentResult = results[subtaskIndex];
            const currentTask = this.testData.subtasks[subtaskIndex];

            judgeTasks.push((async () => {
                // Type minimum is skippable, run one by one
                if (currentTask.type !== SubtaskScoringType.Summation) {
                    let skipped: boolean = false;
                    for (let index = 0; index < currentTask.cases.length; index++) {
                        const currentTaskResult = currentResult.cases[index];
                        if (skipped) {
                            currentTaskResult.status = TaskStatus.Skipped;
                        } else {
                            winston.verbose(`Judging ${subtaskIndex}, case ${index}.`);
                            let score = 0;
                            try {
                                const taskJudge = await this.judgeTestcase(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    currentResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                                currentTaskResult.result = taskJudge;
                                score = taskJudge.scoringRate;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            if (score === 0 || score === NaN) {
                                winston.debug(`Subtask ${subtaskIndex}, case ${index}: zero, skipping the rest.`);
                                skipped = true;
                            }
                            await reportProgress();
                        }
                    }
                } else {
                    // Non skippable, run all immediately
                    const caseTasks: Promise<void>[] = [];
                    for (let index = 0; index < currentTask.cases.length; index++) {
                        caseTasks.push((async () => {
                            const currentTaskResult = currentResult.cases[index];
                            winston.verbose(`Judging ${subtaskIndex}, case ${index}.`);
                            try {
                                currentTaskResult.result = await this.judgeTestcase(currentTask.cases[index], async () => {
                                    currentTaskResult.status = TaskStatus.Running;
                                    currentResult.status = TaskStatus.Running;
                                    await reportProgress();
                                });
                                currentTaskResult.status = TaskStatus.Done;
                            } catch (err) {
                                currentTaskResult.status = TaskStatus.Failed;
                                currentTaskResult.errorMessage = err.toString();
                                winston.warn(`Task runner error: ${err.toString()} (subtask ${subtaskIndex}, case ${index})`);
                            }
                            await reportProgress();
                        })());
                    }
                    await Promise.all(caseTasks);
                }
                if (currentResult.cases.some(c => c.status === TaskStatus.Failed)) {
                    // If any testcase has failed, the score is invaild.
                    currentResult.score = NaN;
                    currentResult.status = TaskStatus.Failed;
                } else {
                    currentResult.score = calculateSubtaskScore(currentTask.type, currentResult.cases.map(c => c.result ? c.result.scoringRate : 0)) * currentTask.score;
                    currentResult.status = TaskStatus.Done;
                }
                winston.verbose(`Subtask ${subtaskIndex}, finished`);
            })());
        }
        await Promise.all(judgeTasks);
        return { status: TaskStatus.Done, subtasks: results };
    }
    protected abstract judgeTestcase(curCase: TestcaseJudge, started: () => Promise<void>): Promise<TestcaseDetails>;
}