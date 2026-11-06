import { longHaulPolicy } from './long-haul';
import { TrafficJobs } from '../registry';
import { freightPolicy } from './freight';
import { passengerPolicy } from './passenger';
import { linerPolicy } from './liner';
import { patrolPolicy } from './patrol';
/**
 * Register the built-in job policies; new NPC purposes extend this registry rather
 * than the traffic controller.
 */
export function createTrafficJobs() {
  const jobs = new TrafficJobs();
  jobs.register(freightPolicy);
  jobs.register(longHaulPolicy);
  jobs.register(passengerPolicy);
  jobs.register(linerPolicy);
  jobs.register(patrolPolicy);
  return jobs;
}
